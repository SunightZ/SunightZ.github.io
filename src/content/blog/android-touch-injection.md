---
title: 'Android 无障碍触摸注入：多指手势与链式调用的实现'
description: 'dispatchGesture 只能「录好再播」，而真实交互要求手指随时按下抬起。本文讲清 GestureDescription 的边界，以及用 Shizuku + InputManager 突破它的完整方案。'
pubDate: 2026-08-05
tags: ['Android', 'Accessibility', 'Input', 'Shizuku']
category: 'Android'
---

做触摸模拟绕不开一个矛盾：

- **无障碍服务**（`AccessibilityService`）人人可用，但只能提交**预先定义好的完整手势**；
- **InputManager 注入**能精确控制每一次 `ACTION_DOWN` / `ACTION_UP`，但需要 `INJECT_EVENTS` 签名权限。

这篇文章把两条路线都拆开讲，重点是第一条的边界到底在哪里，以及第二条怎么借 `Shizuku` 拿到权限。

## 一、dispatchGesture 的工作模型

```java
// 服务声明（res/xml/accessibility_service.xml）
// <accessibility-service android:canPerformGestures="true" ... />
```

提交一次手势：

```java
Path path = new Path();
path.moveTo(500f, 1200f);

GestureDescription.StrokeDescription stroke =
        new GestureDescription.StrokeDescription(path, 0, 60);   // startTime=0ms, duration=60ms

GestureDescription gesture = new GestureDescription.Builder()
        .addStroke(stroke)
        .build();

boolean accepted = dispatchGesture(gesture, new GestureResultCallback() {
    @Override public void onCompleted(GestureDescription g) { /* 这一段播完了 */ }
    @Override public void onCancelled(GestureDescription g) { /* 被打断 */ }
}, null);
```

关键点：**这个手势是一个「录制好的动画」**。系统拿到它之后，
在内部按下手指 → 沿 path 移动 → 抬起，整个过程由系统控时。
你的代码在 `dispatchGesture` 返回后就不再拥有控制权，直到 `onCompleted`。

这也解释了为什么 `dispatchGesture` 会返回 `false`：上一个手势还没播完。

```java
// 必须自己排队，否则会静默失败
private final ArrayDeque<GestureDescription> queue = new ArrayDeque<>();

private void enqueue(GestureDescription gesture) {
    queue.add(gesture);
    if (!isPlaying) dispatchNext();
}
```

## 二、多指手势：靠一次提交多个 Stroke

`GestureDescription` 里所有 stroke 会在同一时间轴上**并发播放**，
这正是实现多指触摸的方式：

```java
private GestureDescription twoFingerPinch(float cx, float cy, float from, float to, long duration) {
    Path a = new Path();   // 手指 1：向外
    a.moveTo(cx - from, cy);
    a.lineTo(cx - to, cy);

    Path b = new Path();   // 手指 2：向外
    b.moveTo(cx + from, cy);
    b.lineTo(cx + to, cy);

    return new GestureDescription.Builder()
            .addStroke(new GestureDescription.StrokeDescription(a, 0, duration))
            .addStroke(new GestureDescription.StrokeDescription(b, 0, duration))
            .build();
}
```

用 `startTime` 可以做出错峰效果，比如「先按住 A，200ms 后再点 B」：

```java
.addStroke(new GestureDescription.StrokeDescription(holdPath, 0, 900))     // 长按
.addStroke(new GestureDescription.StrokeDescription(tapPath, 200, 40))     // 200ms 后点一下
```

### 硬性上限

| 限制 | 取值 | 说明 |
| --- | --- | --- |
| 单次手势最多触摸点 | `GestureDescription.getMaxStrokeCount()`（常见为 10） | 超出直接抛 `IllegalArgumentException` |
| 单次手势最长时长 | `GestureDescription.getMaxGestureDuration()`（60000ms） | 由 `startTime + duration` 的最大值决定 |
| 单段 stroke 最短时长 | 必须 > 0 | 用 1ms 做「瞬时」点击在部分机型上不生效，建议 ≥ 30ms |

### 真正的痛点：手势中途不能加手指

这是这个 API 最根本的限制。设想一个「按住屏幕 + 同时在别处点击」的交互：

- 第 1 帧：需要 1 个点按下；
- 第 50 帧：需要第 2 个点也按下；
- 第 80 帧：第 1 个点抬起，第 2 个点继续按住。

而 `GestureDescription` 在 `build()` 的那一刻，触摸点的**数量和生命周期就全部固定了**。
你没法在一条手势里让某个点中途出现或消失。

## 三、用 willContinue 做链式续接

API 提供了唯一的逃生口：**延续的 stroke（continued stroke）**。

```java
GestureDescription.StrokeDescription first =
        new GestureDescription.StrokeDescription(path1, 0, 300, true);   // willContinue = true

dispatchGesture(new GestureDescription.Builder().addStroke(first).build(),
    new GestureResultCallback() {
        @Override public void onCompleted(GestureDescription gesture) {
            // 在上一段结束前，用 continueStroke 接上，手指不会抬起
            GestureDescription.StrokeDescription next =
                    first.continueStroke(path2, 0, 300, true);

            dispatchGesture(new GestureDescription.Builder().addStroke(next).build(), this, null);
        }
    }, null);
```

`continueStroke(path, startTime, duration, willContinue)` 里的 `startTime`
是**相对于上一段结束时刻的偏移**，传 0 表示无缝衔接——手指不会抬起，系统层面看到的是一次连续长按。

这就是「链式调用」的实现基础。但要注意几个工程细节：

**1. 续接必须及时**
`onCompleted` 回调返回后，你只有很短的窗口去提交下一段。中间夹一次 GC 或者一次网络请求，
手指就抬起来了。所以续接路径必须**提前算好**，不能等到回调里再算。

```java
// 预生成接下来的若干段，回调里只做入队
private final ArrayDeque<GestureDescription> prepared = new ArrayDeque<>();
```

**2. 每段仍然受 60s 上限约束**
长时间按住必须切成多段续接。

**3. 并发手指的续接是独立**
如果你有 3 根虚拟手指都处于 `willContinue` 状态，
每次提交新 gesture 时，必须**把这 3 段都带上**（各自 `continueStroke` 一次），
否则没带上的那根手指就被理解为「这一轮结束了」——于是它抬起来了。

这就是多指 + 长按组合时最反直觉的地方：

```java
// 正确：每次续接都带上所有仍然按下的手指
GestureDescription.Builder builder = new GestureDescription.Builder();
for (VirtualFinger finger : activeFingers) {
    builder.addStroke(finger.continueNext());
}
dispatchGesture(builder.build(), callback, null);
```

**4. 状态机是必须的**
一旦涉及「随时按下抬起」，你就需要一个虚拟手指表，把逻辑手指映射到 stroke，
并在每次续接时决定每根手指是「续接」还是「抬起」：

```java
class VirtualFinger {
    int id;
    Path pending;
    GestureDescription.StrokeDescription last;
    boolean active;

    GestureDescription.StrokeDescription continueNext() {
        GestureDescription.StrokeDescription next =
                last.continueStroke(pending, 0, SEGMENT_MS, /* willContinue = */ active);
        last = next;
        pending = new Path();          // 重置为下一段的路径
        pending.moveTo(curX, curY);
        return next;
    }
}
```

## 四、更直接的路：Shizuku + InputManager

如果交互复杂度再上一层（比如需要按毫秒级精度控制、需要滚轮/按键、需要 20 根手指），
无障碍这条路会越来越难受。此时应该直接用 `InputManager.injectInputEvent`。

它需要的权限是 `android.permission.INJECT_EVENTS`（`signature|privileged`），
普通应用拿不到，但 **shell 有**。所以借 Shizuku 的 `ShizukuBinderWrapper` 就能调用：

```kotlin
val inputManager: IInputManager =
    IInputManager.Stub.asInterface(
        ShizukuBinderWrapper(SystemServiceHelper.getSystemService("input"))
    )
```

然后是核心：构造 `MotionEvent`。多指的关键是**每个事件都必须携带全部指针的状态**。

```kotlin
class MultiTouchInjector(private val im: IInputManager) {
    private val props = mutableListOf<MotionEvent.PointerProperties>()
    private val coords = mutableListOf<MotionEvent.PointerCoords>()
    private var downTime = 0L
    private var pointers = 0

    private fun build(action: Int, ids: List<Int>, xs: FloatArray, ys: FloatArray): MotionEvent {
        val n = ids.size
        val p = Array(n) {
            MotionEvent.PointerProperties().apply {
                id = ids[it]
                toolType = MotionEvent.TOOL_TYPE_FINGER
            }
        }
        val c = Array(n) {
            MotionEvent.PointerCoords().apply {
                x = xs[it]; y = ys[it]
                pressure = 1f; size = 1f
            }
        }

        val maskedAction = when (action) {
            MotionEvent.ACTION_POINTER_DOWN, MotionEvent.ACTION_POINTER_UP ->
                action or (n - 1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT)
            else -> action
        }

        return MotionEvent.obtain(
            downTime, SystemClock.uptimeMillis(), maskedAction,
            n, p, c,
            0, 0, 1f, 1f,
            0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0, 0
        )
    }

    fun down(id: Int, x: Float, y: Float) {
        val action = if (pointers == 0) MotionEvent.ACTION_DOWN else MotionEvent.ACTION_POINTER_DOWN
        downTime = SystemClock.uptimeMillis()
        pointers++
        inject(build(action, idsNow() + id, xsNow() + x, ysNow() + y))
    }

    private fun inject(event: MotionEvent) {
        // MODE_ASYNC 避免等待 InputDispatcher 回执而阻塞调用线程
        im.injectInputEvent(event, IInputManager.INJECT_INPUT_EVENT_MODE_ASYNC)
        event.recycle()
    }
}
```

对比一下两条路线：

| 能力 | dispatchGesture | InputManager 注入 |
| --- | --- | --- |
| 获得权限的难度 | 用户在设置里开启无障碍即可 | 需要 Shizuku / root |
| 手指随时按下抬起 | 需要复杂的续接状态机 | 天然支持 |
| 时间精度 | 由系统控时，约 ±10ms | 由调用方决定 |
| 支持非触摸事件 | 否 | 可以（按键、滚轮） |
| 被应用检测到的风险 | 事件带 `FLAG_INJECTED`，易被识别 | 同样带 `FLAG_INJECTED`，但可控更多字段 |
| 会不会被无障碍开关影响 | 会 | 不会 |

## 五、实战中的坑

**1. `dispatchGesture` 静默失败**
服务未连接、`canPerformGestures` 未声明、上一个手势未结束，都会让返回值变成 `false`。
一定要检查返回值并打日志——不检查的话现象就是「偶尔不生效」，极难定位。

**2. 单点移动用 `moveTo` 会「跳」过去**
`Path` 的第一个点会被当作起点直接落点，之后才沿 `lineTo` 移动。
想从屏幕当前位置开始拖拽，必须把当前坐标写进 `moveTo`。

**3. 显示坐标系与旋转**
`dispatchGesture` 使用**屏幕坐标**，多显示器（`DisplayManager`）或有外接屏时要确认目标 display。
注入方案则需要在事件里显式设置 `displayId`。

**4. 无障碍服务被系统优化掉**
长时间后台运行的无障碍服务可能被省电策略限制。
`dispatchGesture` 失败率会明显上升，需要监听 `onInterrupt()` 并做恢复。

**5. 用 `Handler` 而不是主线程 sleep**
续接必须在回调线程及时提交，但**不能阻塞该线程**。
所有等待都应通过 `Handler.postDelayed` 或独立调度线程完成。

## 小结

- 无障碍路线：**能覆盖 80% 的点击 / 滑动 / 多指需求**，代价是「手势必须预先录制」，
  复杂交互要用 `willContinue` 续接堆状态机，且每次续接必须带上全部仍然按住的手指。
- 注入路线：**表达能力强一个数量级**，代价是需要 Shizuku 或 root，且要自己维护指针 ID 与事件序列。
- 工程上的合理选择：**默认走无障碍，检测到 Shizuku 可用时自动切换到注入**，
  两条路共用同一个「虚拟手指」抽象层，交互逻辑只写一遍。
