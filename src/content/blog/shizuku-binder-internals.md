---
title: 'Shizuku 原理剖析：从 adb shell 到 App 进程的 Binder 直通'
description: '把 Shizuku 拆到 Binder 层：它如何用 shell 身份托管一个 Binder 服务、如何绕过 system_server 的权限检查，以及 ShizukuBinderWrapper 到底包装了什么。'
pubDate: 2026-09-18
tags: ['Android', 'Shizuku', 'Binder', 'adb']
category: 'Android'
pin: true
---

一个普通应用想调用 `IActivityManager#getRunningAppProcesses()`，会被 `system_server` 一句
`Permission Denial: requires android.permission.REAL_GET_TASKS` 顶回来。
但同一台设备上 `adb shell` 执行 `am` 命令却畅通无阻——因为发起调用的 uid 是 **2000（shell）**。

Shizuku 的全部魔法，就是把「这次调用以谁的身份发出」这件事，从应用进程搬到了 shell 进程里。

## 一、Shizuku 进程是怎么起来的

Shizuku 本体不是普通应用，它由 `adb` 或 `root` 拉起：

```bash
# 简化后的启动路径：用 app_process 直接跑一个 Java 程序
adb shell "CLASSPATH=/data/local/tmp/shizuku.jar app_process /system/bin \
  --nice-name=shizuku_server moe.shizuku.server.ShizukuService --debug=false"
```

`app_process` 是 Android 上启动 Java 进程的标准入口（Zygote 自己也是这么起来的）。
它是被 `adbd` fork 出来的子进程，因此**天然继承 uid 2000**，而且不需要任何应用权限声明。

这个进程里做三件事：

1. 注册一个 Binder 服务端 `IShizukuService`，对外暴露 `transactRemote`；
2. 持有 `ServiceManager` 拿到的一批系统服务 binder（`activity`、`package`、`window`…）；
3. 把 binder 交给应用侧，由 `ShizukuProvider` / `ShizukuService` 连接分发。

## 二、权限检查为什么会被绕过

`system_server` 里几乎每个 AIDL 方法第一行都是这个：

```java
// ActivityManagerService 的典型权限检查
final int callingUid = Binder.getCallingUid();
if (callingUid != Process.SYSTEM_UID && !checkComponentPermission(...)) {
    throw new SecurityException("Permission Denial: ...");
}
```

关键在于 `Binder.getCallingUid()` **读的是内核里记录的发起方 uid**，而不是「谁最终想要这个结果」。

于是链路变成：

```text
应用进程 (uid=10xxx)
   └─ ShizukuBinderWrapper.transact()
        └─ [binder] ──► Shizuku 进程 (uid=2000)
                            └─ target.transact()  ← 此时 callingUid = 2000
                                   └─ [binder] ──► system_server
```

对 `system_server` 而言，第二跳的调用者就是 shell。检查自然通过。

<div class="callout">
<span class="callout__title">注意</span>
这不是漏洞，而是 Android 权限模型的一个明确边界：有 shell 权限的进程本来就能做这些事。
Shizuku 只是把「发放 shell 能力」这件事，从「每次输 <code>adb</code> 命令」变成「一次显式授权 + 可随时撤销」。
</div>

## 三、ShizukuBinderWrapper 到底包装了什么

看名字像是个简单代理，实际要处理三个容易踩坑的细节。

### 1. transact 转发

```java
public class ShizukuBinderWrapper extends Binder implements IBinder {
    private final IBinder original;

    @Override
    public boolean transact(int code, Parcel data, Parcel reply, int flags) {
        // 交给 Shizuku 进程去执行原始的 transact
        return Shizuku.getService().transactRemote(original, code, data, reply, flags);
    }
}
```

`transactRemote` 的实现在 shell 进程里，就是把 `data` 的读写位置复位后调用 `original.transact(...)`。

### 2. queryLocalInterface 必须返回 null

`IActivityManager.Stub.asInterface(binder)` 的逻辑是：

```java
public static IActivityManager asInterface(IBinder obj) {
    if (obj == null) return null;
    IInterface iin = obj.queryLocalInterface(DESCRIPTOR);
    if (iin != null && iin instanceof IActivityManager) {
        return (IActivityManager) iin;   // 本地直通，不走 binder
    }
    return new IActivityManager.Stub.Proxy(obj);
}
```

我们的 wrapper 是**跨进程**的代理，如果让它返回一个本地接口实例，
后续所有调用都会在应用进程内完成——也就失去了 shell 身份。

所以 wrapper 必须重写：

```java
@Override
public IInterface queryLocalInterface(String descriptor) {
    return null;   // 强制 asInterface 走 Proxy 分支
}
```

### 3. getInterfaceDescriptor 需要转发

如果 wrapper 不透传描述符，`asInterface` 里的 `DESCRIPTOR` 比对和部分框架校验会失败：

```java
@Override
public String getInterfaceDescriptor() {
    return original.getInterfaceDescriptor();
}
```

## 四、拿到系统服务并调用

最直观的用法是「拿到 shell 身份，然后照常调用系统 API」：

```kotlin
object ShizukuShell {
    private fun service(name: String): IBinder =
        // Shizuku 提供了绕开 hidden API 限制的 ServiceManager 访问
        SystemServiceHelper.getSystemService(name)

    fun activityManager(): IActivityManager =
        IActivityManager.Stub.asInterface(ShizukuBinderWrapper(service("activity")))

    fun packageManager(): IPackageManager =
        IPackageManager.Stub.asInterface(ShizukuBinderWrapper(service("package")))
}
```

在 Activity 里请求授权：

```kotlin
private val permissionListener =
    Shizuku.OnRequestPermissionResultListener { requestCode, grantResult ->
        if (requestCode == REQUEST_CODE && grantResult == PackageManager.PERMISSION_GRANTED) {
            onShizukuReady()
        }
    }

override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    Shizuku.addRequestPermissionResultListener(permissionListener)

    when {
        Shizuku.isPreV11() -> { /* 老版本走旧的 bind 流程 */ }
        Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED -> onShizukuReady()
        Shizuku.shouldShowRequestPermissionRationale() -> showRationale()
        else -> Shizuku.requestPermission(REQUEST_CODE)
    }
}

override fun onDestroy() {
    Shizuku.removeRequestPermissionResultListener(permissionListener)
    super.onDestroy()
}
```

授权状态绑定在**包名 + 签名**上：换签名（比如 debug/release 不一致）会重新要一次授权。
这点在调试期非常容易让人怀疑人生。

## 五、用 shell 身份跑进程

除了转调系统服务，Shizuku 还能直接开一个 shell 子进程，
这在需要调用 `cmd`、`pm`、或者跑自己的 native 程序时特别有用：

```kotlin
val process = Shizuku.newProcess(
    arrayOf("sh", "-c", "pm list packages -3 | wc -l"),
    null,   // 继承环境变量
    null    // 工作目录
)

val output = process.inputStream.bufferedReader().readText().trim()
Log.i("Shizuku", "第三方应用数量：$output")
```

它等价于 `Runtime.exec` 的 shell 版，但**不需要 root，也不需要应用声明任何权限**。
本项目里录屏方案（见《高帧率原画录屏》一文）就是靠它把 `scrcpy-server` 以 shell 身份拉起来的。

## 六、几个实际会踩的坑

**1. hidden API 限制（Android 9+）**
直接反射 `ServiceManager.getService` 会被 `HiddenApi` 拦截。Shizuku 内部对这些调用做了豁免，
自己写的话需要走 `ShizukuSystemServerApi`，或者用 AIDL 重新声明接口——不要试图硬反射。

**2. binder 死亡**
Shizuku 进程被系统回收、或者用户手动停止服务后，所有 wrapper 都会失活：

```kotlin
Shizuku.addBinderDeadListener { /* 清理缓存的 wrapper，提示用户重连 */ }
Shizuku.addBinderReceivedListener { /* 重新初始化 */ }
```

缓存 `IActivityManager` 之类的 wrapper 一定要配合这两个回调一起用，否则会拿到一个永远超时的 binder。

**3. 阻塞式调用要标 allowBlocking**
`ShizukuBinderWrapper(original, /* allowBlocking = */ true)` 用于那些会阻塞很久的调用（如安装应用）。
默认 `false`，长时间阻塞可能触发 binder 线程池问题。

**4. 不要在 binder 线程里做重活**
`transactRemote` 是同步等待的，`system_server` 那边的耗时操作会直接反映到你的调用线程上。

## 小结

把 Shizuku 拆开之后，它的结构其实非常朴素：

| 组件 | 位置 | 作用 |
| --- | --- | --- |
| `IShizukuService` | shell 进程 | 唯一的特权入口，暴露 `transactRemote` |
| `ShizukuBinderWrapper` | 应用进程 | 把普通 binder 调用重定向到 shell 进程 |
| `ServiceManager` 代理 | 应用进程 | 拿到系统服务的原始 binder |
| 授权记录 | Shizuku 服务端 | 校验包名 + 签名 |

理解了「`callingUid` 由内核记录」这一点，剩下的一切都是工程细节。
