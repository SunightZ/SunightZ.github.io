---
title: 'Android Native Hook 入门：从 PLT/GOT 到 inline hook'
description: '不依赖任何 Hook 框架，手写一个 aarch64 的 PLT/GOT hook；再讲清 inline hook 要处理的指令重定位问题，以及 Android linker namespace 带来的硬约束。'
pubDate: 2025-10-15
tags: ['Android', 'C', '逆向', 'ELF']
category: '逆向'
---

Native 层的 Hook 需求通常来自这几处：观察某个系统调用的参数、替换一个私有实现、
或者在第三方库里插一段自己的逻辑。

Frida 很好用，但它要注入、要跑解释器、容易被检测；
很多时候我们只想要一个**静态的、零依赖的**函数替换。这就是 PLT/GOT hook 的场合。

## 一、先理解 PLT/GOT 为什么会存在

外部函数调用（比如 `libfoo.so` 里的代码调用 `libc.so` 的 `open`）
在编译期并不知道 `open` 的最终地址，因为 ASLR 和延迟绑定。

于是链接器插了两级跳板：

```asm
// 调用点：并不直接调 open，而是跳到 PLT 桩
bl      open@plt

// PLT 桩：从 GOT 表里取地址，然后跳过去
open@plt:
    adrp    x16, :got:open
    ldr     x17, [x16, #:got_lo12:open]
    br      x17
```

所以只要**把 GOT 表项里的地址换成我们自己的函数**，所有通过 PLT 发起的调用就都被劫持了。

```text
调用方 ──► PLT 桩 ──► GOT[open] ──► 真正的 open
                         ↑
                    改这里就够了
```

## 二、手写 PLT/GOT hook

不读 ELF 文件、也不依赖解析库，直接用 `dl_iterate_phdr` 遍历已加载模块，
从 `PT_DYNAMIC` 段里取出重定位表。

```c
#define _GNU_SOURCE
#include <dlfcn.h>
#include <elf.h>
#include <link.h>
#include <stdint.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#include <android/log.h>

#define LOG(...) __android_log_print(ANDROID_LOG_INFO, "plthook", __VA_ARGS__)

/* 目标模块所需的信息 */
typedef struct {
    const char *lib_name;   /* 例如 "libc.so" */
    uintptr_t   base;       /* 模块加载基址 */
    const ElfW(Phdr) *phdr;
    size_t      phnum;
    int         found;
} ModuleInfo;

static int find_module(struct dl_phdr_info *info, size_t size, void *data) {
    ModuleInfo *m = (ModuleInfo *)data;
    /* dlpi_name 可能是全路径，用后缀匹配更稳 */
    const char *name = info->dlpi_name ? info->dlpi_name : "";
    if (name[0] == '\0') name = "libc.so";   /* 主程序自身 */

    if (strstr(name, m->lib_name)) {
        m->base  = info->dlpi_addr;
        m->phdr  = info->dlpi_phdr;
        m->phnum = info->dlpi_phnum;
        m->found = 1;
        return 1;   /* 非 0 停止遍历 */
    }
    return 0;
}
```

### 找到重定位表

```c
typedef struct {
    const ElfW(Sym)  *symtab;   /* .dynsym */
    const char       *strtab;   /* .dynstr */
    const ElfW(Rela) *jmprel;   /* .rela.plt */
    size_t            pltrelsz;
} DynTables;

static void parse_dynamic(const ModuleInfo *m, DynTables *t) {
    memset(t, 0, sizeof(*t));

    for (int i = 0; i < m->phnum; ++i) {
        if (m->phdr[i].p_type != PT_DYNAMIC) continue;

        ElfW(Dyn) *dyn = (ElfW(Dyn) *)(m->base + m->phdr[i].p_vaddr);
        for (; dyn->d_tag != DT_NULL; ++dyn) {
            switch (dyn->d_tag) {
            case DT_SYMTAB:  t->symtab  = (const ElfW(Sym) *)dyn->d_un.d_ptr; break;
            case DT_STRTAB:  t->strtab  = (const char *)dyn->d_un.d_ptr;      break;
            case DT_JMPREL:  t->jmprel  = (const ElfW(Rela) *)dyn->d_un.d_ptr; break;
            case DT_PLTRELSZ: t->pltrelsz = dyn->d_un.d_val;                  break;
            }
        }
        break;
    }
}
```

**注意** `DT_SYMTAB` / `DT_STRTAB` 给出来的已经是**运行时绝对地址**（linker 会做重定位），
所以不要再加 `m->base`，否则会读到野内存。

### 改写 GOT

```c
/* 让包含 addr 的内存页可写 */
static int make_writable(void *addr, size_t len) {
    long page = sysconf(_SC_PAGESIZE);
    uintptr_t start = (uintptr_t)addr & ~(uintptr_t)(page - 1);
    uintptr_t end   = ((uintptr_t)addr + len + page - 1) & ~(uintptr_t)(page - 1);

    return mprotect((void *)start, end - start, PROT_READ | PROT_WRITE);
}

int plt_hook(const char *lib_name, const char *sym_name, void *new_func, void **old_func) {
    ModuleInfo m = { .lib_name = lib_name };
    dl_iterate_phdr(find_module, &m);
    if (!m.found) {
        LOG("module not found: %s", lib_name);
        return -1;
    }

    DynTables t;
    parse_dynamic(&m, &t);
    if (!t.symtab || !t.jmprel || !t.strtab) return -1;

    size_t count = t.pltrelsz / sizeof(ElfW(Rela));

    for (size_t i = 0; i < count; ++i) {
        const ElfW(Rela) *rel = &t.jmprel[i];

        /* 只要 JUMP_SLOT（函数）类型，GLOB_DAT 是数据引用 */
        if (ELF64_R_TYPE(rel->r_info) != R_AARCH64_JUMP_SLOT) continue;

        size_t sym_index = ELF64_R_SYM(rel->r_info);
        const char *name = t.strtab + t.symtab[sym_index].st_name;

        if (strcmp(name, sym_name) != 0) continue;

        /* GOT 表项的实际地址 */
        void **got_entry = (void **)(m.base + rel->r_offset);

        if (make_writable(got_entry, sizeof(void *)) != 0) return -1;

        if (old_func) *old_func = *got_entry;   /* 保存原地址，可做透传 */
        *got_entry = new_func;

        LOG("hooked %s@%s: %p -> %p", sym_name, lib_name, *old_func, new_func);
        return 0;
    }

    LOG("symbol not found: %s", sym_name);
    return -1;
}
```

### 用起来

```c
static int (*real_open)(const char *, int, ...);

static int my_open(const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list ap; va_start(ap, flags);
        mode = va_arg(ap, mode_t);
        va_end(ap);
    }
    LOG("open: %s", path);
    return real_open(path, flags, mode);
}

__attribute__((constructor))
static void on_load(void) {
    plt_hook("libc.so", "open", (void *)my_open, (void **)&real_open);
}
```

## 三、PLT/GOT hook 的边界

它**只能拦截通过 PLT 发起的调用**。以下几种情况会漏掉：

| 情况 | 会不会被 hook 到 |
| --- | --- |
| 其他模块通过 PLT 调用 `open` | ✅ 会 |
| 目标模块**内部**直接调用自己的函数 | ❌ 不会（没有走 PLT） |
| 通过函数指针调用（`dlsym` 拿到的地址） | ❌ 不会 |
| `static` / 被内联的函数 | ❌ 不会 |
| 已经解析好的、被缓存到寄存器里的地址 | ❌ 不会 |

要覆盖这些，就得上 **inline hook**。

## 四、inline hook 难在哪

思路很直接：把目标函数开头几条指令改成一条跳转，跳到我们的实现。

```asm
// 原始
stp x29, x30, [sp, #-16]!
mov x29, sp
...

// Hook 后
ldr x17, #8
br  x17
<我们的函数地址>
```

难点不在改写，而在**被覆盖掉的那几条指令怎么办**。aarch64 上有几类指令一旦搬家就会失效：

- `B` / `BL`（相对跳转，±128MB）
- `ADR` / `ADRP`（PC 相对取地址）
- `LDR literal`（PC 相对加载常量）
- `CBZ` / `TBNZ` 等条件分支

所以必须实现一个**指令重定位器**：把这几条指令改写成等价的、与 PC 无关的形式，
再放进 trampoline 里执行，最后跳回原函数。

另外还有并发问题：改写指令的瞬间，其他线程可能正执行到这几条指令上（aarch64 上取指与数据缓存不一致还可能读到旧指令）。
严肃的实现要么暂停所有线程，要么用「先写跳转、再原子替换首字节」的双写技巧。

**结论：不要自己写 inline hook。** 直接用成熟的：

```c
// ShadowHook（字节跳动开源，对 Android 支持最好）
#include "shadowhook.h"
void *stub = shadowhook_hook_sym_addr((void *)target, (void *)replace, (void **)&orig);

// Dobby
#include "dobby.h"
DobbyHook((void *)target, (void *)replace, (void **)&orig);
```

这两个库都处理好了指令重定位、缓存一致性和线程安全。

## 五、Android linker namespace 的硬约束

这是 Android 上最容易卡住人的地方，和 Hook 技术本身无关：

从 Android 7 开始，linker 引入了 **namespace**：

```text
app namespace     ──► 只能看到 NDK 公开库（libc.so / libm.so / liblog.so …）
system namespace  ──► 系统私有库（libart.so / libinputflinger.so …）
vndk namespace    ──► VNDK 库
```

所以**普通应用 `dlopen("libart.so")` 一定失败**，报 `library "libart.so" not found`——
文件明明存在，是 namespace 不让你看。

三种绕法：

```c
// 1. 用完整路径 dlopen（仍受 namespace 限制，多半不行）
// 2. android_dlopen_ext + 自定义 namespace（需要系统权限）
// 3. 直接读 /proc/self/maps 找基址，再用 ELF 解析拿到符号偏移
```

实际最常用的是第 3 种：**不 dlopen，直接算地址。**

```c
/* 从 /proc/self/maps 找模块基址，完全不依赖 linker */
static uintptr_t find_base(const char *lib_name) {
    FILE *fp = fopen("/proc/self/maps", "r");
    if (!fp) return 0;

    char line[512];
    uintptr_t base = 0;

    while (fgets(line, sizeof(line), fp)) {
        /* 找到 r-xp 的可执行段起始，通常就是基址 */
        if (strstr(line, lib_name) && strstr(line, "r-xp")) {
            base = (uintptr_t)strtoull(line, NULL, 16);
            break;
        }
    }
    fclose(fp);
    return base;
}
```

拿到基址后，符号偏移可以从本地那份 `.so` 文件里离线解析（`readelf -s` 或自己写 ELF 解析），
运行时 `目标地址 = base + 偏移`。

## 六、用户态与内核态的分工

| 方式 | 位置 | 能拦到什么 | 代价 |
| --- | --- | --- | --- |
| PLT/GOT hook | 用户态 | 跨模块 PLT 调用 | 零性能损失，覆盖有限 |
| inline hook | 用户态 | 任意函数入口 | 需要指令重定位，风险高 |
| `seccomp` / `ptrace` | 用户态 | 系统调用 | 性能开销大 |
| kprobe | 内核态 | 内核函数入参出参 | 需要 root / 可加载模块 |
| sys_call_table 改写 | 内核态 | 全部系统调用 | 与内核版本强绑定，易崩 |
| LSM hook | 内核态 | 权限判定点 | 需要内核支持与签名 |

KernelSU / SukiSU 这类方案走的是内核态：在 `sys_call_table` 或 LSM hook 上做文章，
所以能覆盖到**所有**进程，而应用层的 hook 只能管自己进程。

## 小结

- **PLT/GOT hook 是性价比最高的一档**：几十行代码、零开销、不需要框架，
  代价是只能拦住走 PLT 的调用；
- **inline hook 不要自己写**，用 ShadowHook / Dobby；
- **Android 上真正的门槛是 linker namespace**，
  解决办法是绕开 linker，用 `/proc/self/maps` + 离线 ELF 解析自己算地址；
- Hook 之外，`mprotect` 改页属性是所有用户态方案共同的前提——
  忘记它就会拿到一个 SIGSEGV，而不是一个错误码。
