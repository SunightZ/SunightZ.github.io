---
title: 'C 语言可视化图形交互的工程化实践'
description: '从 graphics.h 的闪烁问题出发，把课程级的小程序整理成有事件循环、控件抽象和双缓冲的小型 GUI——顺便说清这些原理在现代 GUI 里为什么依然成立。'
pubDate: 2025-12-09
tags: ['C', 'GUI', '图形编程']
category: 'C/C++'
---

用 `graphics.h` 写交互界面，第一个遇到的现象一定是**闪烁**：
鼠标一动、界面一重绘，整个屏幕就像被人按了开关一样忽明忽暗。

大多数人会用「少画点东西」来回避，但根因其实很清楚，而且解法是通用的。
把它整理清楚，顺便就能得到一个结构上说得过去的交互程序。

## 一、闪烁的根因：没有帧的概念

最朴素的写法是这样：

```c
while (1) {
    cleardevice();          // 1. 擦干净
    draw_background();      // 2. 画背景
    draw_buttons();         // 3. 画按钮
    draw_cursor();          // 4. 画光标
    delay(16);
}
```

问题在于：**这四步是直接画在屏幕上的**。第 1 步执行完的那一瞬间，
用户看到的是一个空白屏幕；等第 4 步执行完才看到完整画面。
中间那些「半成品」帧就是闪烁。

本质是：**渲染被拆成了多次可见的写入**。解法只有一个——
**让所有绘制发生在不可见的地方，最后一次性呈现**，也就是双缓冲。

### 方案 1：WinBGIm 的页切换

```c
initwindow(WIDTH, HEIGHT);
setactivepage(1);      // 后续绘制都画到第 1 页（不可见）

while (running) {
    handle_input();
    update_state();

    cleardevice();
    draw_scene();

    setvisualpage(1);  // 一次性把第 1 页呈现出来
    setactivepage(0);  // 反向切换，两页交替使用
    delay(16);
}
```

### 方案 2：EasyX 的批量绘制

```c
BeginBatchDraw();      // 开启批量绘制，绘制内容不会立刻上屏
while (running) {
    handle_input();
    update_state();

    cleardevice();
    draw_scene();

    FlushBatchDraw();  // 统一提交
    Sleep(16);
}
EndBatchDraw();
```

### 方案 3：自己管内存 DC（Win32）

```c
HDC hdc = GetDC(hwnd);
HDC memDC = CreateCompatibleDC(hdc);
HBITMAP memBmp = CreateCompatibleBitmap(hdc, WIDTH, HEIGHT);
HBITMAP oldBmp = SelectObject(memDC, memBmp);

// 所有绘制都往 memDC 上做
draw_scene(memDC);

// 一次 BitBlt 贴到屏幕
BitBlt(hdc, 0, 0, WIDTH, HEIGHT, memDC, 0, 0, SRCCOPY);

SelectObject(memDC, oldBmp);
DeleteObject(memBmp);
DeleteDC(memDC);
ReleaseDC(hwnd, hdc);
```

三种方案原理完全相同：**离线渲染 + 原子提交**。
现代浏览器合成层、游戏的 back buffer，做的都是同一件事。

## 二、事件循环：别用阻塞式输入

`getch()` 会把程序卡住直到有输入，导致动画停摆。
正确结构是三阶段，每帧跑一遍：

```c
typedef struct {
    int running;
    int mouse_x, mouse_y;
    int mouse_down;
    unsigned int frame;
} AppState;

void main_loop(void) {
    AppState app = { .running = 1 };

    while (app.running) {
        unsigned int t0 = GetTickCount();

        poll_input(&app);       // 1. 输入：非阻塞地取事件
        update(&app);           // 2. 更新：只改状态，不碰屏幕
        render(&app);           // 3. 渲染：只读状态，不改状态

        // 固定步长，锁定目标帧率
        unsigned int elapsed = GetTickCount() - t0;
        if (elapsed < FRAME_MS) Sleep(FRAME_MS - elapsed);
        app.frame++;
    }
}
```

`poll_input` 用 `kbhit()` + `getch()` 组合，或者用 Win32 的 `PeekMessage` 不阻塞地取消息：

```c
void poll_input(AppState *app) {
    // 键盘：有按键才读，绝不阻塞
    if (kbhit()) {
        int key = getch();
        switch (key) {
            case 27: app->running = 0; break;   // ESC
            case ' ': /* ... */ break;
        }
    }

    // 鼠标：WinBGIm 提供 ismouseclick 这类非阻塞接口
    // Win32 下则从 PeekMessage 里取 WM_MOUSEMOVE / WM_LBUTTONDOWN
}
```

**「更新」和「渲染」分离**是整个架构里最重要的一条纪律。
一旦在渲染函数里改了状态，逻辑就会变得无法预测、无法测试，
而且换渲染后端时会把逻辑一起带死。

## 三、控件抽象：用结构体 + 函数指针

界面一复杂，`if (x > 100 && x < 200 && ...)` 这种硬编码判断会迅速失控。
抽出最小可用的控件模型：

```c
typedef struct Widget Widget;

struct Widget {
    int  x, y, w, h;
    const char *label;
    int  hovered;
    int  pressed;
    int  visible;
    void (*on_click)(Widget *self, void *user);
    void *user;
};

static int hit_test(const Widget *w, int mx, int my) {
    return mx >= w->x && mx < w->x + w->w
        && my >= w->y && my < w->y + w->h;
}

/* 返回 1 表示这个事件被消费了 */
int widget_handle(Widget *w, const Event *ev) {
    if (!w->visible) return 0;

    switch (ev->type) {
    case EV_MOUSE_MOVE:
        w->hovered = hit_test(w, ev->x, ev->y);
        return w->hovered;

    case EV_MOUSE_DOWN:
        w->pressed = hit_test(w, ev->x, ev->y);
        return w->pressed;

    case EV_MOUSE_UP: {
        int was = w->pressed;
        w->pressed = 0;
        /* 按下和抬起都在同一个控件内才算点击 */
        if (was && hit_test(w, ev->x, ev->y)) {
            if (w->on_click) w->on_click(w, w->user);
            return 1;
        }
        return 0;
    }
    }
    return 0;
}
```

再往上就是一层很薄的事件分发：**从最上层往下遍历**，第一个命中的控件吃掉事件。

```c
int dispatch(Widget **widgets, int count, const Event *ev) {
    for (int i = count - 1; i >= 0; --i) {   // 后添加的在最上层
        if (widget_handle(widgets[i], ev)) return 1;
    }
    return 0;
}
```

这套「结构体 + 函数指针 + 命中测试 + z-order 逆序遍历」的模式，
和现代 GUI 框架的保留模式（retained mode）在结构上是一致的。

## 四、页面/场景管理：一个栈就够了

多页面（主菜单 → 设置 → 关于）不要用一堆布尔标志：

```c
typedef struct {
    void (*on_enter)(void *ctx);
    void (*on_update)(void *ctx, const Event *ev);
    void (*on_render)(void *ctx);
    void (*on_exit)(void *ctx);
    const char *name;
} Scene;

static Scene *scene_stack[MAX_DEPTH];
static int scene_top = 0;

void push_scene(Scene *s, void *ctx) {
    if (scene_top > 0) scene_stack[scene_top - 1]->on_exit(ctx);
    scene_stack[scene_top++] = s;
    s->on_enter(ctx);
}

void pop_scene(void *ctx) {
    if (scene_top == 0) return;
    scene_stack[--scene_top]->on_exit(ctx);
    if (scene_top > 0) scene_stack[scene_top - 1]->on_enter(ctx);
}
```

好处是「返回上一页」天然成立，而且每个页面的状态可以完全独立地初始化与释放。

## 五、资源与帧率

**资源加载一次，全局持有。**
图片、字体、音效如果在每帧加载，帧率会掉到个位数，
而且 Windows 上的 GDI 对象有句柄上限（默认 10000），很快就会耗尽。

```c
typedef struct {
    void *background;
    void *btn_normal;
    void *btn_hover;
    void *btn_pressed;
} Resources;

static Resources g_res;   /* 启动时加载，退出时释放 */
```

**帧率用固定步长而不是 `Sleep(1)`。**
`Sleep(1)` 在 Windows 上实际会睡 10~15ms（调度粒度），帧率会飘。
用目标帧长减去实际耗时来睡：

```c
#define TARGET_FPS 60
#define FRAME_MS   (1000 / TARGET_FPS)
```

另外可以只重绘「脏区域」（dirty rect），把 `BitBlt` 的范围限制在变化的部分。
对静态菜单这类界面，收益非常明显。

## 六、如果要换到现代图形库

`graphics.h` 是 1980 年代的 BGI 接口，今天只在教学环境里还有意义。
但把它换掉，代价比想象中小——只要前面几层抽象做到位了：

| 层 | 现在的实现 | 换到 SDL2 / raylib |
| --- | --- | --- |
| 绘制原语 | `line` / `rectangle` / `outtextxy` | `SDL_RenderDrawLine` / `DrawRectangle` / `DrawText` |
| 双缓冲 | `setvisualpage` / `FlushBatchDraw` | 天然内置（SDL_RenderPresent） |
| 输入 | `kbhit` / `ismouseclick` | `SDL_PollEvent` |
| 主循环 | 自己写 | 自己写（结构完全一样） |
| 控件 / 场景 / 资源 | 已经抽象好了 | **不用改** |

真正需要重写的只有「绘制原语」这一层薄封装。

```c
/* 把渲染后端抽成接口，上层逻辑就与图形库解耦了 */
typedef struct {
    void (*clear)(void);
    void (*rect)(int x, int y, int w, int h, Color c);
    void (*text)(int x, int y, const char *s, Color c);
    void (*present)(void);
} Renderer;
```

## 小结

一个「不闪烁、能交互、加页面不用改主循环」的 C 图形程序，需要的东西其实不多：

1. **双缓冲** —— 离线渲染 + 原子提交，从根上消灭闪烁；
2. **输入 / 更新 / 渲染三阶段分离** —— 让逻辑与显示解耦；
3. **控件结构体 + 命中测试 + 逆序分发** —— 界面增长时不失控；
4. **场景栈** —— 多页面管理的基本单位；
5. **资源预加载 + 固定步长** —— 帧率稳定的前提。

这五条和语言无关，也和图形库无关。
把 `graphics.h` 换成 SDL 或者 OpenGL，它们一条都不用改。
