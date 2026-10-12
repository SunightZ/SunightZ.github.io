---
layout: home

hero:
  name: 小白录制
  text: 高帧率屏幕录制与视频处理
  tagline: 系统录屏 / Shizuku / Root 三种采集方式，系统声音与麦克风混音，区域录制、悬浮球、屏幕标注与视频工具箱。没有账号，没有云端，录制内容只留在你自己的设备上。
  image:
    src: /shots/home.jpg
    alt: 小白录制 主页
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/
    - theme: alt
      text: 版本对比
      link: /versions
    - theme: alt
      text: 隐私政策
      link: /privacy

features:
  - title: 三种采集方式，按需要选
    details: 默认走系统录屏授权（MediaProjection，最省事）；装了 Shizuku 可以免系统录屏弹窗、直接镜像主屏；有 Root 则交给系统级进程采集，高帧率下掉帧更少。
  - title: 声音可分开处理
    details: 系统声音与麦克风各自独立开关，两路增益 0～200% 分别可调，混音后限幅输出，不修改手机本身的播放音量。
  - title: 参数按设备给
    details: 分辨率、帧率（最高跟随屏幕刷新率，如 120 FPS）、码率、H.264/H.265、关键帧间隔 1～10 秒；参数超出设备编码能力时会明确报错，而不是录出一堆坏帧。
  - title: 录制时也能操作
    details: 可拖动悬浮球随时开始/停止/暂停，区域录制只录选中的一块屏幕，录制中还能直接在画面上圈点标注。
  - title: 录完不用换 App
    details: 内置视频工具箱：格式转换、提取音频、压缩、旋转镜像、音量调整、超分、抖音投稿帧数优化，结果另存，原文件不动。
  - title: 隐私写在明处
    details: 无账号体系、无广告、无统计上报、不建用户画像；唯一的联网行为是首次使用视频工具箱时下载 FFmpeg 运行库，并按内置 SHA-256 逐个校验。
---

<div class="sr-section">

## 界面

<div class="sr-shots">
  <figure class="sr-shot">
    <img src="/shots/home.jpg" alt="主页：参数预览与录制方式" />
    <figcaption>主页 · 参数预览、录制方式与画面设置</figcaption>
  </figure>
  <figure class="sr-shot">
    <img src="/shots/tool.jpg" alt="工具页：视频工具箱" />
    <figcaption>工具 · 格式转换、倒放、超分、音量调整…</figcaption>
  </figure>
  <figure class="sr-shot">
    <img src="/shots/album.jpg" alt="相册页：录制列表" />
    <figcaption>相册 · 列表 / 网格、时长与体积一览</figcaption>
  </figure>
</div>

<p class="sr-lede">三张都是真机截图，未做任何裁切与缩放。主页把当下会用到的参数一次性摊开，工具页是录制之后的处理入口，相册负责浏览与整理（截图来自完整版，Shizuku / Root 是完整版功能）。</p>

</div>

<div class="sr-section">

## 两个版本

同一套录制与处理能力，拆成两个工程：**完整版**保留 Root / Shizuku 采集与触摸可视化，**精简版**只保留系统录屏（MediaProjection）链路，包体与权限都更收敛。

<div class="sr-scroll">

| | <span class="sr-tag full">完整版</span> | <span class="sr-tag lite">精简版</span> |
| --- | --- | --- |
| 系统录屏（MediaProjection） | 支持 | 支持 |
| Shizuku 采集（免录屏弹窗 / 镜像主屏） | 支持 | — |
| Root 采集（系统级进程） | 支持 | — |
| 显示触摸位置 | 支持 | — |
| 声音、区域录制、悬浮球、屏幕标注、视频工具箱、相册 | 支持 | 支持 |
| 面向 | 游戏录制、需要高帧率与低占用 | 日常录屏、只要系统授权 |

</div>

[看完整对比 →](./versions.md)

</div>

<div class="sr-section">

## 获取与支持

- **精简版**：随仓库发布，直接安装即可，免费。
- **完整版**：通过开发者公布的社群渠道获取，是否收费以该渠道说明为准。

<div class="sr-note">
<strong>没有账号，也没有云端。</strong>录制文件、处理结果与全部配置都留在本机；卸载应用会删除应用私有目录里的配置与临时文件，你自己保存位置里的视频不会被自动删除。
</div>

</div>
