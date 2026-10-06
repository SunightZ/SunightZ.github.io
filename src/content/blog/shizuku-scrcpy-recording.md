---
title: 'Shizuku + scrcpy：在没有 PC 的设备上做原画高帧率录屏'
description: '把 scrcpy-server 用 shell 身份拉起来、绕过 adb 直接连本地 socket、再把 H.265 码流零转码封装进 MP4——一套完全跑在手机上的高清录屏链路。'
pubDate: 2026-04-12
tags: ['Android', 'Shizuku', 'scrcpy', 'MediaCodec']
category: 'Android'
---

`scrcpy` 的能力一直被 PC 挡着：要一根数据线、要 `adb`、要一个能跑 GUI 的桌面。
但它的核心——一个跑在设备侧、以 shell 身份持有编码器的 **server**——其实完全可以自己托管。

只要解决三件事，录屏就能彻底脱离 PC：

1. 用 `Shizuku` 把 `scrcpy-server` 以 shell 身份启动；
2. 不走 adb forward，直接连 **本地抽象 socket**；
3. 把编码后的码流**零转码**封进 MP4。

## 一、先看清 scrcpy 的链路

PC 版 scrcpy 做的事其实很朴素：

```text
PC:  adb push scrcpy-server.jar /data/local/tmp/
     adb shell CLASSPATH=/data/local/tmp/scrcpy-server.jar \
         app_process / com.genymobile.scrcpy.Server <version> <options>
     adb forward tcp:27183 localabstract:scrcpy
     ──── 从这里开始纯粹是 socket 通信 ────
```

设备侧 server 会：

- 通过 hidden API 拿到主显示的 `SurfaceControl`，把 `MediaCodec` 的 input Surface 作为它的输出目标；
- 用 `MediaCodec` 做 H.264 / H.265 硬编码；
- 在 `LocalServerSocket("scrcpy")` 上监听，把码流按 scrcpy 的自定义协议推出去。

**关键洞察**：`adb forward` 只是在 PC 和设备之间搬运字节。
如果消费者也在设备上，这一层就完全是多余的——应用可以直接连那个 `localabstract` socket。

## 二、把 server 拉起来

### 1. jar 放哪儿

难点在于：shell 进程（uid 2000）**读不到应用的私有目录** `/data/user/0/<pkg>/files/`（0700，SELinux 也不放行）。

可行的落点是 `/data/local/tmp/`（shell 可读写），但应用自己又写不进去。
所以走一个两跳：

```kotlin
// 1) 应用把 jar 写到自己可写、shell 也可读的位置
val jar = File(getExternalFilesDir(null), "scrcpy-server.jar")
assets.open("scrcpy-server.jar").use { input ->
    jar.outputStream().use { input.copyTo(it) }
}

// 2) 借 Shizuku 用 shell 身份把它搬到 /data/local/tmp
val cmd = "cp '${jar.absolutePath}' /data/local/tmp/scrcpy-server.jar && " +
          "chmod 644 /data/local/tmp/scrcpy-server.jar"

Shizuku.newProcess(arrayOf("sh", "-c", cmd), null, null).waitFor()
```

`getExternalFilesDir()` 在 `/sdcard/Android/data/<pkg>/files/`，应用可写、shell 可读，
是唯一同时满足两个条件的中间站。

### 2. 启动 server

```kotlin
private fun startServer(version: String, options: String): Process {
    // app_process 以 shell 身份跑 Java 程序，等价于 adb shell 里那条命令
    val cmd = "CLASSPATH=/data/local/tmp/scrcpy-server.jar " +
              "app_process / com.genymobile.scrcpy.Server $version $options"

    return Shizuku.newProcess(arrayOf("sh", "-c", cmd), null, null)
}
```

`options` 决定了画质，这里是要点：

```text
scid=0                       # 会话 id
log_level=info
audio=false                  # 先关掉音频，避免采集冲突
control=false                # 不需要远程控制时关掉，省一条 socket
video_codec=h265             # H.265 在同码率下画质明显更好
video_bit_rate=104857600     # 100 Mbps，接近原画
max_fps=120                  # 跟随高刷屏
max_size=0                   # 0 = 保持原生分辨率
tunnel_forward=false         # 关键：不要走 adb forward
```

`tunnel_forward=false` 让 server 自己开 `LocalServerSocket`，
这正是我们要的——app 直接连它，不经过任何端口转发。

## 三、连接与读取

```kotlin
private fun connect(socketName: String = "scrcpy"): LocalSocket {
    val socket = LocalSocket()
    socket.connect(LocalSocketAddress(socketName, LocalSocketAddress.Namespace.ABSTRACT))
    return socket
}
```

拿到 socket 后要**先吃掉协议头**，否则第一帧数据会被当成像素：

```kotlin
private fun readHandshake(input: InputStream): Pair<Int, Int> {
    input.read()                                   // dummy byte，固定 0
    input.readNBytes(64)                           // 设备名，定长 64
    val width = readShortBE(input)
    val height = readShortBE(input)
    return width to height
}
```

再往后就是编码器吐出的裸码流（byte-buffer 模式，Annex-B 起始码）。
拿到宽度高度之后，根据需要跳过设备元数据，就可以开始往文件里写了。

## 四、零转码封装进 MP4

这是「原画」的关键：**不要解码再编码**。码流已经是硬编产物，直接 mux 就是帧级无损。

```kotlin
val muxer = MediaMuxer(outputFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)

val format = MediaFormat.createVideoFormat(
    MediaFormat.MIMETYPE_VIDEO_HEVC, width, height
).apply {
    // 参数集必须正确，否则播放器解不出来
    setByteBuffer("csd-0", spsAndPps)
}

val track = muxer.addTrack(format)
muxer.start()

var ptsUs = 0L
val frameDurationUs = 1_000_000L / fps

buffer.use { buf ->
    while (!stopped) {
        val size = readFrame(buf)                  // 从 socket 读一个完整帧
        if (size <= 0) break

        val info = MediaCodec.BufferInfo().apply {
            set(0, size, ptsUs, if (isKeyFrame(buf, size)) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
        }
        muxer.writeSampleData(track, buf, info)
        ptsUs += frameDurationUs
    }
}

muxer.stop()
muxer.release()
```

三个必须处理的细节：

**1. 参数集（SPS/PPS/VPS）**
`MediaMuxer` 需要 `csd-0` 才能让播放器初始化解码器。
如果码流里参数集是随帧内联的（不少编码器会这样），就要自己从第一个 IDR 帧里
扫出 `00 00 00 01 67`（SPS）/ `68`（PPS）/ `40`（VPS，HEVC）并组装成 `csd-0`。
否则现象是：文件能生成、有体积，但播放器一片黑或直接报错。

**2. 时间戳从零开始、单调递增**
`writeSampleData` 的 `presentationTimeUs` 必须单调。
直接拿系统时间当 pts 会因为起点非零导致首帧延迟，所以自己维护一个累加器。

**3. 帧边界**
socket 是流式的，一个 `read()` 不保证返回一帧。
必须自己按 Annex-B 起始码（`00 00 01` / `00 00 00 01`）做切分，
否则 `writeSampleData` 收到的是半帧，muxer 会报 `IllegalStateException` 或者产出一个坏文件。

```kotlin
/** 找到下一帧的起始码位置，返回本帧长度 */
private fun nextFrameLength(buf: ByteArray, from: Int): Int {
    var i = from + 3
    while (i < buf.size - 3) {
        if (buf[i] == 0.toByte() && buf[i + 1] == 0.toByte() &&
            (buf[i + 2] == 1.toByte() ||
             (buf[i + 2] == 0.toByte() && buf[i + 3] == 1.toByte()))
        ) return i - from
        i++
    }
    return buf.size - from
}
```

## 五、高帧率的真正瓶颈

打开 `max_fps=120` 之后，屏幕刷新率成了下一个瓶颈。几个实际会遇到的：

**1. 编码器能力上限**
不是所有 SoC 都能 4K120 硬编。开跑前应该先查：

```kotlin
val codec = MediaCodecList(MediaCodecList.REGULAR_CODECS).findEncoderForFormat(
    MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_HEVC, width, height)
)
val caps = codec?.codecInfo?.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_HEVC)
        ?.videoCapabilities

val supported = caps?.areSizeAndRateSupported(width, height, 120.0) ?: false
```

不支持时会静默降级到 30fps，或者直接抛 `MediaCodec.CodecException`。
按 `getSupportedFrameRatesFor(w, h)` 的返回值做自适应比硬设 120 更稳。

**2. 分辨率对齐**
多数硬编要求宽高是 2 的倍数，部分要求 16 对齐。
遇到编码器直接拒绝的情况，先试着把 `max_size` 设成 1080 系列值排除对齐问题。

**3. 热节流**
100 Mbps 的 H.265 长时间录制会让 SoC 迅速升温到 throttling 区间，
表现为帧率阶梯式下滑。可以监听：

```kotlin
val pm = getSystemService(PowerManager::class.java)
pm.addThermalStatusListener(Executor { it.run() }) { status ->
    when (status) {
        PowerManager.THERMAL_STATUS_MODERATE -> reduceBitrate(0.7f)
        PowerManager.THERMAL_STATUS_SEVERE   -> reduceBitrate(0.4f)
    }
}
```

**4. SurfaceFlinger 的 buffer 数量**
高帧率下如果编码器消费不及时，帧会被丢弃（表现为画面跳帧而不是卡顿）。
适度降低 `video_bit_rate` 反而能提升实际流畅度——编码器不再成为瓶颈。

## 六、和 MediaProjection 方案对比

顺带回答一个常见问题：既然有 `MediaProjection`，为什么要绕这么大一圈？

| 维度 | MediaProjection | scrcpy-server（Shizuku） |
| --- | --- | --- |
| 用户授权 | 每次录制弹窗确认 | 一次性 Shizuku 授权 |
| 可录制内容 | 受 `FLAG_SECURE` 限制，部分界面黑屏 | 直接镜射显示，不受此限制 |
| 最高帧率 | 取决于 `VirtualDisplay` 配置 | 可指定 120fps |
| 码率控制 | `MediaRecorder` 黑盒 | `MediaCodec` 全参数可控 |
| 分辨率 | 会强制缩放对齐 | `max_size=0` 保持原生 |
| 是否需要额外服务 | 否 | 需要用户装 Shizuku |

要「能录就行」，用 `MediaProjection`；
要「画质和帧率都不妥协」，只有 `scrcpy-server` 这条路。

## 小结

整条链路的本质是：**scrcpy 的 server 本来就是设备上的一个普通 Java 进程**，
PC 只是恰好用 adb 把它拉起来、再用端口转发读它的输出。
把这两个「恰好」换成 `Shizuku.newProcess` 和本地抽象 socket，
剩下的编码与封装逻辑（`MediaCodec` + `MediaMuxer`，全程零转码）与 PC 方案完全一致。

排查顺序建议固定下来：**先确认 server 起来了 → 再确认 socket 连上了 → 再确认握手头吃对了 → 最后才怀疑 muxer**。
这四步能覆盖 95% 的「录出来是黑屏 / 花屏 / 打不开」。
