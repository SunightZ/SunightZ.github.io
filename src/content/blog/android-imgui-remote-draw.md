---
title: '在 Android 上用 Dear ImGui 做远程绘制'
description: '把 PC 端生成的 ImDrawData 序列化后发到设备渲染：跨进程传顶点的四个致命细节、字体图集的正确处理，以及一条能跑满 60fps 的链路。'
pubDate: 2026-02-27
tags: ['C++', 'ImGui', 'Android', 'OpenGL']
category: 'C++'
---

Dear ImGui 是调试界面的最优解：改一行代码就多一个滑块，不用写布局、不用管回调。
但它的渲染后端要拿到 **OpenGL / Vulkan 上下文**，而 Android 上这件事比 PC 麻烦得多。

如果界面逻辑本来就该跑在 PC（比如读的是 PC 侧的内存数据、日志、仿真状态），
那还有一个更省事的思路：**ImGui 在 PC 端跑，设备端只负责把顶点画出来**。

## 一、架构

```text
┌──────────────────── PC ────────────────────┐
│  ImGui::NewFrame()                          │
│  ... 界面逻辑、读业务数据 ...                │
│  ImGui::Render()                            │
│  ImDrawData* dd = ImGui::GetDrawData()      │
│            ↓ 序列化                          │
│         socket ──────────────────────────►  │
└─────────────────────────────────────────────┘
┌──────────────── Android ───────────────────┐
│  反序列化 → EGL/GLES 渲染 → eglSwapBuffers   │
└─────────────────────────────────────────────┘
```

设备端因此**不需要链接 ImGui**，只需要一份「照着命令列表画三角形」的渲染代码——
本质上是把 `imgui_impl_opengl3` 的 `RenderDrawData` 搬过来。

## 二、协议设计

只传渲染必需的东西：

```cpp
#pragma pack(push, 1)

struct RDrawVert {
    float    pos[2];
    float    uv[2];
    uint32_t col;
};
static_assert(sizeof(RDrawVert) == 20, "顶点布局必须两端一致");

struct RDrawCmd {
    uint32_t elemCount;    // 索引个数
    uint32_t idxOffset;
    uint32_t vtxOffset;
    float    clipRect[4];
    int32_t  textureSlot;  // 注意：不是指针！
};

struct RFrameHeader {
    float    displayPos[2];
    float    displaySize[2];
    float    framebufferScale[2];
    uint32_t vtxCount;
    uint32_t idxCount;
    uint32_t cmdCount;
    uint32_t texUpdateCount;
};

#pragma pack(pop)
```

## 三、四个会直接导致花屏的坑

### 坑 1：结构体布局

`ImDrawVert` 在 PC 上是 `{ImVec2 pos; ImVec2 uv; ImU32 col;}`，
看起来是 20 字节，但**编译器可能插入填充**，而且 `ImVec2` 在不同配置下可能是 `double`。
所以：

- 用 `#pragma pack(push,1)` 或 `__attribute__((packed))` 固定布局；
- 用固定宽度类型（`uint32_t`、`float`）重新声明，不要直接 `memcpy` ImGui 的原始结构；
- 加 `static_assert` 把约定钉死，一旦有人改了定义编译期就报错。

### 坑 2：ImDrawIdx 的位宽

```cpp
// imgui.h
#ifndef ImDrawIdx
typedef unsigned short ImDrawIdx;   // 默认 16 位！
#endif
```

顶点数超过 65535 时 16 位索引会溢出（ImGui 会拆成多个 CmdList，但跨进程时你必须知道是哪一种）。
最省事的做法是**两端都定义同一个宏**：

```cpp
// 两端的 CMakeLists / Android.mk 都要加
add_compile_definitions(ImDrawIdx=unsigned int)
```

否则 PC 发 2 字节索引、设备按 4 字节读，画面会变成随机三角形。

### 坑 3：ImTextureID 是指针，不能跨进程

`ImDrawCmd::GetTexID()` 返回的是 `void*`、指向 PC 进程地址空间里的 GL 纹理。
传到设备端毫无意义。

正确做法是维护一张**纹理槽位表**：

```cpp
// PC 端发送前：把指针翻译成稳定槽位
std::unordered_map<ImTextureID, int32_t> slotOf;
int32_t slot = slotOf.count(cmd.GetTexID()) ? slotOf[cmd.GetTexID()]
                                            : registerTexture(cmd.GetTexID());
```

设备端收到 `textureSlot` 后查自己的纹理数组。索引 `-1` 可以约定成「默认字体图集」。

### 坑 4：UserCallback 无法序列化

`ImDrawCmd` 里如果有 `ImDrawCallback`（比如用 `ImDrawList::AddCallback` 做自定义绘制），
设备端没有对应函数可调。发送前直接断言掉：

```cpp
for (const ImDrawList* list : dd->CmdLists) {
    for (const ImDrawCmd& cmd : list->CmdBuffer) {
        IM_ASSERT(cmd.UserCallback == nullptr && "远程绘制不支持回调");
    }
}
```

## 四、字体图集：最容易漏的一步

ImGui 的默认字体是一张**动态生成的纹理图集**，顶点里的 `uv` 是相对这张图集的归一化坐标。
如果两端各自 `Build()` 字体图集，只要字体、字号、`OversampleH/V` 有任何一点不同，
`uv` 全部错位，表现为文字乱码或糊成一片。

可靠的做法是**图集由 PC 端生成并下发一次**：

```cpp
// PC 端：把图集像素取出来发过去
unsigned char* pixels; int w, h;
ImGuiIO& io = ImGui::GetIO();
io.Fonts->GetTexDataAsRGBA32(&pixels, &w, &h);

sendTextureUpdate(slot = 0, w, h, pixels, w * h * 4);
io.Fonts->SetTexID((ImTextureID)(intptr_t)0);   // 约定 0 号槽就是字体图集
```

设备端只做一件事：

```cpp
glGenTextures(1, &fontTex);
glBindTexture(GL_TEXTURE_2D, fontTex);
glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
```

运行时如果 `io.Fonts->TexID` 变化（比如用户拖动了字号），要再发一次更新。

## 五、设备端渲染

核心是照抄 `imgui_impl_opengl3` 的绘制循环，只是数据来自反序列化：

```cpp
void renderFrame(const RFrame& f) {
    const int fbW = f.header.displaySize[0] * f.header.framebufferScale[0];
    const int fbH = f.header.displaySize[1] * f.header.framebufferScale[1];

    glViewport(0, 0, fbW, fbH);
    glEnable(GL_BLEND);
    glBlendEquation(GL_FUNC_ADD);
    glBlendFuncSeparate(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA, GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
    glDisable(GL_CULL_FACE);
    glDisable(GL_DEPTH_TEST);
    glDisable(GL_STENCIL_TEST);
    glEnable(GL_SCISSOR_TEST);

    glUseProgram(program);
    glBindVertexArray(vao);
    glBindBuffer(GL_ARRAY_BUFFER, vbo);
    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, ebo);

    // 每帧上传顶点与索引（ImGui 的顶点缓冲是逐帧重建的）
    glBufferData(GL_ARRAY_BUFFER, f.vtx.size() * sizeof(RDrawVert), f.vtx.data(), GL_STREAM_DRAW);
    glBufferData(GL_ELEMENT_ARRAY_BUFFER, f.idx.size() * sizeof(uint32_t), f.idx.data(), GL_STREAM_DRAW);

    for (const RDrawCmd& cmd : f.cmds) {
        // clipRect 是屏幕坐标，OpenGL 的 scissor 原点在左下角，需要翻转
        const float clipX = cmd.clipRect[0] - f.header.displayPos[0];
        const float clipY = cmd.clipRect[1] - f.header.displayPos[1];
        const float clipW = cmd.clipRect[2] - cmd.clipRect[0];
        const float clipH = cmd.clipRect[3] - cmd.clipRect[1];

        glScissor((int)clipX, (int)(fbH - (clipY + clipH)), (int)clipW, (int)clipH);

        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, textures[cmd.textureSlot]);
        glUniform1i(uTex, 0);

        glDrawElementsBaseVertex(
            GL_TRIANGLES,
            cmd.elemCount,
            GL_UNSIGNED_INT,
            (void*)(sizeof(uint32_t) * cmd.idxOffset),
            cmd.vtxOffset
        );
    }

    glDisable(GL_SCISSOR_TEST);
}
```

**`glDrawElementsBaseVertex` + `vtxOffset` 是必须的**：
ImGui 会把多个 `ImDrawList` 的顶点合并到同一个缓冲里，用 `vtxOffset` 做偏移。
如果忽略它，界面会整体错位——而且错得很有规律，容易误判成网络丢包。

## 六、EGL 初始化（Android 侧）

```cpp
void initEGL(ANativeWindow* window) {
    display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    eglInitialize(display, nullptr, nullptr);

    const EGLint configAttrs[] = {
        EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
        EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
        EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
        EGL_NONE
    };
    EGLConfig config; EGLint numConfig;
    eglChooseConfig(display, configAttrs, &config, 1, &numConfig);

    const EGLint surfaceAttrs[] = { EGL_NONE };
    surface = eglCreateWindowSurface(display, config, window, surfaceAttrs);

    const EGLint contextAttrs[] = { EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE };
    context = eglCreateContext(display, config, EGL_NONE, contextAttrs);

    eglMakeCurrent(display, surface, surface, context);
    eglSwapInterval(display, 1);   // 跟随 vsync，避免撕裂与空转
}
```

三个易错点：

1. **`ANativeWindow` 的生命周期**
   从 `Surface` / `SurfaceHolder` 拿到，必须在 `surfaceDestroyed` 时
   `eglDestroySurface` 并停止渲染线程——否则会拿到野指针直接 SIGSEGV。

2. **尺寸变化**
   `ANativeWindow_getWidth/Height` 在旋转后变化，要重新 `glViewport`，
   并且 PC 端也要同步新的 `displaySize`。

3. **渲染线程**
   EGL context 必须固定在同一个线程使用。
   不要在主线程创建、在子线程 `eglMakeCurrent`——会失败或者行为不确定。

## 七、降低延迟：交互感的来源

60fps 下每帧往返哪怕只有 20ms，滑块拖拽也会感觉「粘手」。实测有效的优化：

**1. 只发变化的部分**
ImGui 每帧重建顶点，但静态 UI 的顶点逐字节相同。
对顶点缓冲做哈希，没变就只发一个「复用上一帧」的标志位。实测能省掉 90% 以上的带宽。

```cpp
const uint64_t hash = xxh3(vtxData, vtxBytes);
if (hash == lastHash) {
    header.flags |= FRAME_REUSE_GEOMETRY;
} else {
    lastHash = hash;
    sendVertices(vtxData, vtxBytes);
}
```

**2. 压缩**
顶点数据高度冗余（相邻顶点坐标只差几个像素），LZ4 能压到 20%~30%，
解压开销在手机上可以忽略。

**3. 本地预测**
PC 端自己也渲染一份（用户实际看的是 PC 屏幕），设备端只作为第二显示。
这样交互延迟永远是 0，远程链路只负责展示。

**4. 固定小端序**
跨设备通信一定要显式约定字节序。x86 和 ARM 都是小端，但**不要假设**——
写个 `static_assert` 或者干脆手写序列化。

## 小结

远程绘制的复杂度不在渲染，而在**把 ImGui 的内存模型翻译成可传输的数据模型**：

| PC 端的东西 | 跨进程后变成 |
| --- | --- |
| `ImDrawVert`（可能有填充） | 固定 20 字节 packed 结构 |
| `ImDrawIdx`（16/32 位不定） | 两端统一宏，固定 32 位 |
| `ImTextureID`（进程内指针） | 纹理槽位索引 |
| `ImDrawCallback`（函数指针） | 不支持，发送前断言 |
| 字体图集（两端各建一份） | PC 生成、下发一次 |

把这张表处理干净，剩下的就是一次普通的 GL 绘制。
