---
title: '骁龙 8650 GKI 内核编译：从源码到可刷入镜像'
description: 'SM8650 平台上的完整内核构建流程：GKI 2.0 的镜像拆分逻辑、LLVM 工具链配置、ThinLTO 的内存坑、以及 AnyKernel3 打包与 AVB 校验的处理。'
pubDate: 2026-06-21
tags: ['Kernel', 'GKI', 'Android', 'SM8650']
category: '内核'
---

给一台骁龙 8650 的机器换内核，很多人卡在最后一步：
镜像编出来了、刷进去了、然后设备起不来或者 vendor 模块加载失败。

问题几乎都不在编译本身，而在 **GKI 2.0 的镜像拆分**没搞清楚。

## 一、先理解 GKI 2.0 到底拆了什么

Android 11 之前，内核是「一坨」：内核 + 所有驱动模块一起编译、一起刷入。
GKI（Generic Kernel Image）之后变成了两层：

```text
┌─────────────────────────────────────────────┐
│  boot.img                                    │
│  ├── Image            ← 通用内核（GKI）      │  Google 提供，KMI 稳定
│  └── ramdisk          ← 通用 ramdisk         │
├─────────────────────────────────────────────┤
│  vendor_boot.img                             │
│  ├── vendor ramdisk   ← 厂商 init + 配置     │
│  └── dtb / dtbo       ← 设备树               │
├─────────────────────────────────────────────┤
│  vendor_dlkm.img                             │
│  └── *.ko             ← 厂商驱动模块         │
└─────────────────────────────────────────────┘
```

两者之间靠 **KMI（Kernel Module Interface）** 连接：
vendor 模块要能加载进你的内核，前提是内核导出的符号集合与 KMI 一致。

这直接决定了编译策略：

- **只换 GKI 部分**（最常见的需求）：用 AOSP 的 `kernel/common`，保持 KMI 冻结的符号不删；
- **带厂商代码编**：用厂商放出的 OSS 源码，但要自己保证符号完整。

SM8650 对应的是 **android14-6.1** 分支（Android 14 / Linux 6.1）。

## 二、环境准备

```bash
sudo apt update && sudo apt install -y \
  bc bison build-essential ccache curl flex g++-multilib gcc-multilib git gnupg \
  gperf imagemagick libelf-dev liblz4-tool libncurses-dev libsdl1.2-dev libssl-dev \
  libxml2 libxml2-utils lzop pngcrush rsync schedtool squashfs-tools xsltproc \
  zip zlib1g-dev python3 python-is-python3 cpio kmod
```

LLVM 工具链用 AOSP 的预编译版本（不要用系统 `clang`，版本对不上会直接编不过）：

```bash
git clone --depth=1 \
  https://android.googlesource.com/platform/prebuilts/clang/host/linux-x86 \
  -b main clang-prebuilt

export CLANG_DIR="$PWD/clang-prebuilt/clang-r510928"
export PATH="$CLANG_DIR/bin:$PATH"
clang --version        # 确认版本，后面会写进内核 banner
```

`clang-r510928` 只是示例，**必须和你的内核分支推荐的版本一致**。
每个分支的 `build/build.config` 里都写着所需的 clang 版本，照着抄。

## 三、拉源码

```bash
# 通用 GKI 内核
git clone --depth=1 -b android14-6.1 \
  https://android.googlesource.com/kernel/common kernel-common

# 厂商 BSP（以 OnePlus/OPPO 为例，从 OSS 发布页拿对应机型的源码包）
git clone --depth=1 -b <vendor-tag> <vendor-kernel-url> kernel-vendor
```

用厂商源码时还要单独拉 AOSP 的公共部分：

```bash
./tools/bazel run //common:kernel_aarch64_dist   # Kleaf 会自动同步依赖
```

## 四、编译

### 路线 A：直接 make（适合改驱动、快速迭代）

```bash
cd kernel-common
make O=out ARCH=arm64 LLVM=1 <device>_defconfig
make O=out ARCH=arm64 LLVM=1 -j"$(nproc)" Image
```

`LLVM=1` 会自动把 `CC/LD/AR/...` 全套指向 LLVM 工具链，
比一个个设 `CC=clang CROSS_COMPILE=...` 可靠得多（5.15+ 内核都支持）。

产出的关键文件：

```text
out/arch/arm64/boot/Image        ← 未压缩内核
out/arch/arm64/boot/Image.lz4    ← 压缩版（部分设备 boot 分区用这个）
out/arch/arm64/boot/dts/**/*.dtb
```

### 路线 B：Kleaf / Bazel（GKI 官方方式）

```bash
tools/bazel build //common:kernel_aarch64_dist --config=fast
```

`--config=fast` 会关掉一部分优化换取编译速度，正式出包不要带。

### ThinLTO 的内存坑

GKI 的 `gki_defconfig` 默认开 `CONFIG_LTO_CLANG_THIN=y`。
LTO 的链接阶段是**单进程**的，峰值内存能到 16 GB 以上：

```bash
# 内存不够的典型报错
ld.lld: error: LLVM ERROR: out of memory
```

三种处理方式，按推荐顺序：

```bash
# 1. 降并发（LTO 阶段并发没意义，但前面的编译阶段会抢内存）
make O=out ARCH=arm64 LLVM=1 -j4 Image

# 2. 加 swap
sudo fallocate -l 16G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile

# 3. 彻底关掉 LTO（会带来性能损失，且可能与 KMI 校验冲突）
scripts/config --file out/.config -d LTO_CLANG_THIN -e LTO_NONE
make O=out ARCH=arm64 LLVM=1 olddefconfig
```

顺带把 `ccache` 打开，第二次编译会快得多：

```bash
export CCACHE_DIR="$HOME/.ccache"
export CC="ccache clang"
```

## 五、注入 KernelSU / SukiSU

以 SukiSU 为例（KernelSU 分支，支持 GKI）：

```bash
curl -LSs https://raw.githubusercontent.com/SukiSU-Ultra/SukiSU-Ultra/main/kernel/setup.sh | bash -s main
```

脚本会做三件事：打补丁、把 `drivers/kernelsu` 加进 `Makefile`、写入配置项。
手动确认这几项：

```ini
CONFIG_KSU=y
CONFIG_KSU_MANUAL_HOOK=y      # 或者 trace hook，看内核版本支持
CONFIG_KPROBES=y
```

**注意**：`CONFIG_KSU` 会改变部分内核结构布局，如果同时还要保持 KMI 兼容，
需要额外处理 `CONFIG_TRIM_UNUSED_KSYMS`——否则 KMI 校验会失败。

## 六、打包

### AnyKernel3（推荐，最不容易翻车）

AnyKernel3 的优点是**复用设备原有的 ramdisk 和 dtb**，只替换内核本体：

```bash
git clone --depth=1 https://github.com/osm0sis/AnyKernel3

cp out/arch/arm64/boot/Image AnyKernel3/
# 如果设备需要压缩内核：
# lz4 -l -12 --favor-decSpeed out/arch/arm64/boot/Image AnyKernel3/Image.lz4

cd AnyKernel3
zip -r9 ../kernel-sukisu.zip . -x "*.git*" "*.zip" "README.md"
```

`anykernel.sh` 里要改的只有两处：

```bash
kernel.string=Sunight Kernel for SM8650
device.name1=<你的设备代号>
```

### mkbootimg（需要完整控制时）

```bash
mkbootimg \
  --kernel Image \
  --ramdisk ramdisk.cpio.gz \
  --cmdline "console=ttyMSM0,115200n8 androidboot.hardware=qcom" \
  --base 0x00000000 \
  --kernel_offset 0x00008000 \
  --ramdisk_offset 0x01000000 \
  --tags_offset 0x00000100 \
  --pagesize 4096 \
  --header_version 4 \
  --os_version 14.0.0 \
  --os_patch_level 2024-05 \
  --output boot.img
```

`--os_version` 和 `--os_patch_level` 不是装饰：**它们参与 AVB 校验和 anti-rollback 判断**，
写错会导致刷入后直接进 bootloader。

## 七、AVB 与 dm-verity

修改过 boot 分区后，AVB 的哈希对不上，表现是开机卡在 bootloader 警告页
或者反复重启进 recovery。两种处理：

```bash
# 方案 1：禁用验证（调试用，会降低安全性）
avbtool make_vbmeta_image \
  --flags 2 \
  --padding_size 4096 \
  --output vbmeta_disabled.img

# 方案 2：用你的密钥重新签名（推荐）
avbtool add_hash_footer \
  --partition_name boot \
  --partition_size $((64 * 1024 * 1024)) \
  --image boot.img \
  --algorithm SHA256_RSA2048 \
  --key testkey_rsa2048.pem
```

同时 `cmdline` 里要加：

```text
androidboot.veritymode=disabled
```

## 八、失败排查清单

按顺序对照，能覆盖绝大多数「刷完起不来」：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 停在 bootloader | AVB 校验失败 | 重新签名 vbmeta 或 `--flags 2` |
| `Unknown symbol` 加载模块失败 | KMI 符号被裁剪 | 关掉 `CONFIG_TRIM_UNUSED_KSYMS` |
| `version magic mismatch` | 内核版本字符串与模块不一致 | 保持 `LOCALVERSION` 与官方一致 |
| 无限重启但能进 recovery | 内核 panic（多半是 defconfig 缺驱动） | 接串口 / 看 `last_kmsg` |
| WiFi / 蓝牙失效 | `vendor_dlkm` 与内核 KMI 不匹配 | 用匹配分支重编，别跨版本 |
| 触摸失效 | dtb 不匹配 | 用 AnyKernel3 保留原 dtb |
| 编译 OOM | ThinLTO | 降 `-j` 或加 swap |

拿日志最直接的方式是串口，但没有拆机条件时可以用：

```bash
adb shell "cat /sys/fs/pstore/console-ramoops-0" > last_boot.log
```

`pstore` 里保存着上一次崩溃前的内核日志，是排查启动失败最有价值的现场。

## 小结

GKI 把「编内核」变成了「编一个符合契约的内核」，难度从驱动移植转移到了**契约对齐**：

- 分支要对（SM8650 → android14-6.1）；
- clang 版本要对（照 `build.config` 抄）；
- KMI 符号不能裁（`CONFIG_TRIM_UNUSED_KSYMS` 慎用）；
- AVB 要处理（否则根本进不了系统）。

把 `Image` 编出来只是走了一半，**打包方式和 AVB 处理才是决定能不能开机的那一半**。
