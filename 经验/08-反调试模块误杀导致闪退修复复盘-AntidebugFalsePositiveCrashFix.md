# 反调试模块误杀导致 Release 闪退修复复盘

> 项目：IDE-BYOK | 修复版本：v1.2.2 | 时间：2026-06-08

---

## 一、问题现象

Release 模式运行 `ide-byok.exe` 出现两种闪退：

| 场景 | 表现 |
|------|------|
| 打开就闪退 | 双击 exe 后窗口一闪而过，或根本不出现窗口 |
| 开启代理后几分钟闪退 | 正常使用，启动代理后 2-5 分钟内突然退出，无任何提示 |

Dev 模式（`cargo tauri dev`）完全正常，仅 Release 模式出问题。

---

## 二、根因分析

### 2.1 代码定位

`lib.rs` 中 Release 模式独有逻辑：

```rust
#[cfg(not(debug_assertions))]
{
    antidebug::clear_hardware_breakpoints();
    antidebug::start_patrol();  // ← 启动巡逻线程，每 2 秒检测一次

    // integrity 校验
    integrity::verify_sidecar()?;       // ← 失败直接 exit(1)
    integrity::verify_resources(&dir)?; // ← 失败直接 exit(1)
}
```

### 2.2 闪退原因一：`IsDebuggerPresent()` 误报

**现象**：打开就闪退

**根因**：部分安全软件（杀毒、反恶意软件、系统监控工具）会向目标进程注入 DLL 以实现钩子监控。注入过程中会短暂修改进程的 PEB 结构，导致 `IsDebuggerPresent()` 返回非零值。antidebug 巡逻线程检测到后立即 `process::exit(1)`，且 Release 模式设置了 `windows_subsystem = "windows"` 不显示控制台，所以看不到任何错误提示。

**原代码**：一次检测到异常就直接退出，无容错机制。

### 2.3 闪退原因二：`check_timing_anomaly()` 误报

**现象**：开启代理后几分钟闪退

**根因**：代理运行时涉及 MITM 解密、请求转发等 CPU 密集操作，加上系统后台任务，偶尔会出现超过 100ms 的调度延迟。antidebug 每 2 秒检测一次，只要某次 `QueryPerformanceCounter` 间隔超过 100ms 就判定为调试器断点暂停，直接退出。

**原代码**：

```rust
// 阈值仅 100ms，正常负载波动就可能超过
let threshold_ticks = freq / 100;  // 10ms
delta > threshold_ticks * 10       // 100ms → 视为异常
```

### 2.4 闪退原因三：`integrity` 校验失败直接退出

**现象**：重新编译后首次运行闪退

**根因**：`verify_sidecar()` 将 sidecar 的 SHA-256 哈希与上次记录的基线比对。重新编译后哈希变化，比对失败 → `process::exit(1)`。开发/测试阶段频繁重编译，每次都会触发。

---

## 三、修复方案

### 3.1 antidebug：连续检测 + 提高阈值

| 参数 | 修复前 | 修复后 |
|------|--------|--------|
| timing 阈值 | 100ms | 1s |
| 误判策略 | 1 次异常即退出 | 连续 3 次异常才退出 |
| 正常时行为 | — | 重置计数器 |

```rust
const STRIKE_LIMIT: u32 = 3;
static STRIKE_COUNT: AtomicU32 = AtomicU32::new(0);

// 巡逻线程中：
if check_debugger() || check_timing_anomaly() {
    let strikes = STRIKE_COUNT.fetch_add(1, Ordering::SeqCst) + 1;
    eprintln!("[antidebug] 异常检测 strike {}/{}", strikes, STRIKE_LIMIT);
    if strikes >= STRIKE_LIMIT {
        // 还原配置 → 退出
        std::process::exit(1);
    }
} else {
    STRIKE_COUNT.store(0, Ordering::SeqCst);  // 正常时重置
}
```

**为什么 3 次 + 1s 是合理的**：
- 正常 CPU 调度抖动极少连续 3 次超过 1s
- 真正的调试器断点会导致持续暂停，3 次 2s 间隔（共 6s）内必定触发
- 安全软件注入的短暂异常通常只触发 1 次，不会连续 3 次

### 3.2 integrity：校验失败改为警告 + 自动更新基线

```rust
// 修复前：校验失败直接退出
if baseline.trim() != current_hash {
    return Err("Sidecar 二进制被篡改".into());
}

// 修复后：打印警告 + 更新基线
if baseline.trim() != current_hash {
    eprintln!("[integrity] 警告: sidecar 哈希不匹配，可能被篡改或重新编译");
    fs::write(&baseline_path, current_hash)?;  // 更新基线
}
```

### 3.3 lib.rs：integrity 失败不再 exit

```rust
// 修复前
if let Err(e) = integrity::verify_sidecar() {
    eprintln!("[integrity] sidecar 校验失败: {}", e);
    std::process::exit(1);
}

// 修复后
if let Err(e) = integrity::verify_sidecar() {
    eprintln!("[integrity] sidecar 校验警告: {}", e);
}
```

---

## 四、排查方法备忘

Release 闪退因为没有控制台窗口，很难直接看到错误。排查手段：

### 4.1 命令行启动捕获 stderr

```powershell
cd src-tauri\target\release
Start-Process -FilePath ".\ide-byok.exe" -NoNewWindow -PassThru `
    -RedirectStandardError ".\crash-stderr.log"
# 等待一段时间后检查
Get-Content .\crash-stderr.log -Encoding UTF8
```

### 4.2 临时启用控制台窗口

注释掉 `main.rs` 中的 `windows_subsystem = "windows"`，重新编译后运行可以看到 eprintln 输出：

```rust
// #![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
```

### 4.3 快速验证是否是 antidebug 导致

临时注释掉 `lib.rs` 中的 antidebug 启动代码，重新编译后测试：

```rust
// #[cfg(not(debug_assertions))]
// {
//     antidebug::clear_hardware_breakpoints();
//     antidebug::start_patrol();
// }
```

如果注释后不再闪退，确认是 antidebug 误杀。

---

## 五、经验 Checklist

- [x] **反调试检测必须做连续确认**：1 次检测就退出太激进，正常环境（安全软件注入、CPU 负载波动）都会误报
- [x] **timing 阈值不能太低**：100ms 在代理等 CPU 密集场景下极易误触发，1s 是更安全的阈值
- [x] **integrity 校验失败不应直接退出**：开发阶段频繁重编译会导致基线失效，应改为警告 + 自动更新
- [x] **Release 闪退排查第一步**：用命令行启动 + 重定向 stderr，或临时注释 `windows_subsystem = "windows"` 看控制台输出
- [x] **反调试逻辑与业务逻辑隔离**：antidebug 巡逻线程不应影响正常功能，异常退出前必须还原 IDE 配置（已有，但需确保执行到）
- [x] **版本号必须随修改提升**：否则无法确认运行的是新版本还是旧缓存

---

## 六、相关文件

| 文件 | 改动 |
|------|------|
| `src-tauri/src/antidebug.rs` | 连续 3 次检测机制 + timing 阈值提升到 1s |
| `src-tauri/src/integrity.rs` | 校验失败改为警告 + 自动更新基线 |
| `src-tauri/src/lib.rs` | integrity 失败不再 exit(1) |
| `src-tauri/Cargo.toml` | 版本号 1.2.1 → 1.2.2 |
| `src-tauri/tauri.conf.json` | 版本号 1.2.1 → 1.2.2 |
| `package.json` | 版本号 1.2.1 → 1.2.2 |
