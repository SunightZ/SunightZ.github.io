# 三种录制方式

「小白录制」有三条采集链路，在主页「录制方式」里用两个开关选择：

| 开关组合 | 模式 | 需要什么 |
| --- | --- | --- |
| 都关 | **系统录屏** | 每次开始确认一次系统录屏授权 |
| 只开 Shizuku | **Shizuku** | 已安装并启动 Shizuku，且已授权本应用 |
| 只开 Root | **Root** | 设备已 Root，并在 Root 管理器里授权 |
| 都开 | 无效组合 | 应用提示「旧配置中的录制方式冲突，请重新选择。」 |

<div class="sr-note">
<strong>完整版功能。</strong>Shizuku 与 Root 采集只在完整版里提供；精简版只有系统录屏，两个开关不出现。三种方式都支持音频、区域录制、悬浮球、屏幕标注与视频工具箱。
</div>

## 系统录屏（MediaProjection）

**默认方式，什么都不用额外准备。**

点击开始录制后，系统会弹出录屏授权确认框，确认后开始。采集链路是：

```
MediaProjection.createVirtualDisplay → OpenGL 旋转处理层 → MediaCodec 输入 Surface
```

屏幕画面先进 OpenGL 层做旋转与缩放，再交给编码器，所以横竖屏切换时画面能正确铺满固定尺寸的视频。

**代价**：授权只对本次会话有效，每次开始都要确认一次。这是 Android 的系统机制，不是应用可以绕过的。

**系统声音**：走 `AudioPlaybackCaptureConfiguration`，Android 10 及以上可用。

## Shizuku

通过 Shizuku 拿到 shell 权限，用隐藏的 `DisplayManager.createVirtualDisplay(name, width, height, displayId, surface)` 直接镜像主屏，**不再需要系统录屏弹窗**。

Shizuku 不支持这个隐藏接口时，会回退到项目里 shell 上下文的 AUTO_MIRROR 接口。

### 系统声音怎么来的

这是 Shizuku 模式最讲究的一处。声音在 shell 进程里通过 AudioPolicy / LOOP_BACK_RENDER 捕获，**保留本机播放**——也就是说手机自己还在正常出声，不会为了录屏把手机录成静音。

具体做法是填充 shell Application 与 AttributionSource 后创建双声道录音端点；麦克风也在同一个 shell 进程里采集，混音后编码 AAC，通过文件描述符写入应用文件。停止或失败时会释放 `AudioRecord` 并注销 AudioPolicy，**不会回退到会让本机静音的直采路径**。

### 版本要求

| 能力 | 最低版本 |
| --- | --- |
| 仅麦克风 | Android 11（API 30） |
| 系统声音 | Android 13（API 33） |

不满足时应用明确报错，不会静默降级：

> 保留本机播放的 Shizuku 系统音频需要 Android 13+

> Shizuku 音频捕获需要 Android 11 或以上；Android 10 可使用无声录制或普通录屏模式

Android 11 上麦克风采集走 scrcpy 的 shell 前台 Activity 兼容流程，**请先解锁再启动**。

### 前台服务类型

Android 14 及以上的 Shizuku 录制前台服务使用 `specialUse` 类型，旧版本使用普通前台服务；**不启用** mediaProjection / microphone 类型，因为这个模式本来就不走那两条 API。

### 前置准备

主页选中 Shizuku 后会显示说明与两个链接：

> 请先启动 Shizuku。系统声音需 Android 13+，麦克风需 Android 11+。

- 「Shizuku 激活教程」——打开 `bilibili://video/BV1UrKazKEkC`，没有 B 站客户端时回退到 `https://b23.tv/Sof7nhh`
- 「下载 Shizuku」——指向 Shizuku v13.6.0 的 APK

## Root

由系统级进程直接采集画面与声音，避开应用层转发与跨进程等待。

实现上是一个独立的可执行文件（打包为 `lib/arm64-v8a/libsrroot.so`，由特权进程按路径启动）。它自己启动一个 ART 运行时，把整条链路——镜像显示 → OpenGL 旋转 → 视频编码 → 音频采集编码 → MP4 封装——都放在一个进程里，参数全部从命令行传入。没有 Binder 传 Surface，没有第二个进程，也没有 libsu 中转。

这意味着：

- **录制不依赖应用进程存活**。应用被划掉或被杀，录制进程自己收尾保存——`MediaMuxer` 只在停止时才写文件索引，没有这层保护，用户最想保住的那段录制就没了。
- **文件直接写进你选的目录**，并由录制进程自己登记进系统媒体库。所以应用已经被杀掉的那段录制，同样会出现在相册里。
- **通知栏计时、悬浮球、标注、相机预览不在这个进程里**——它们属于应用层，仍由应用负责。

选中 Root 后会显示：

> 使用 Root 管理器授权；无需系统录屏授权。

### 性能差异

开发者在同一台设备、播同一段内容、使用完全相同参数（原画分辨率 @ 屏幕最高刷新率）实测的结果：

| 指标 | 系统录制 | Shizuku | Root |
| --- | --- | --- | --- |
| 每帧 CPU 耗时 | 8.89 ms | 6.40 ms | 6.20 ms |
| 超预算帧 | 1.87% | 1.27% | 1.25% |
| 掉帧 | 1.70% | 1.45% | 1.24% |

数值会随设备与负载变化，**负载越高、帧率越高，差距越明显**。详见[实测数据](/premium/benchmark)。

## 显示触摸位置

选中 Shizuku 或 Root 后，「录制方式」区块会多出一个「显示触摸位置」开关：

> 录制时显示系统小白点，结束后关闭

实现方式是开始录制时执行系统 `settings` 命令打开 `show_touches`，正常停止或启动失败时恢复原值。

<div class="sr-note">
<strong>进程被强制结束时系统开关可能停在打开状态</strong>，需要手动到「开发者选项」里关掉「显示点按操作反馈」。
</div>

想要更好看的触摸效果（四种样式、可调颜色与大小），用[触摸可视化](/record/touch)，它是独立开关，不需要开始录制。

## 该选哪一种

| 你的情况 | 建议 |
| --- | --- |
| 偶尔录一下屏幕，不想折腾 | 系统录屏 |
| 常录游戏，要 120 FPS，不想每次点系统弹窗 | Shizuku |
| 需要长时间录制、要求最稳 | Root |
| 需要录制时显示点按操作 | 完整版 + Shizuku 或 Root |

## 失败时怎么办

- **Shizuku 模式报错**：Shizuku 的 shell / 隐藏 API 路径依赖系统实现，部分 ROM 需要额外兼容处理。失败时应用会明确提示，可以取消该选项改用系统录屏模式。
- **Root 模式报错**：确认已在 Root 管理器里授予本应用权限；部分机型需要额外的 SELinux 策略支持。
- **受保护内容录出来是黑屏**：部分应用的 DRM 视频、支付页、银行类界面系统不允许被捕获，这是系统级限制，任何录屏应用都一样。

## 相关

- [录制参数](/record/parameters) —— 分辨率、帧率、码率怎么设
- [声音与混音](/record/audio) —— 两路音源与增益
- [高级版权益](/premium/) —— 试用与解锁
