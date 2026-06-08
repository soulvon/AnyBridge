// antidebug.rs — 反调试/反逆向保护模块
// 参考 WindsurfGate 实现，但精简到核心检测
//
// 防误杀策略：
//   - timing 阈值从 100ms 提高到 1s（正常负载波动不会超过，调试器断点会导致秒级暂停）
//   - 连续 N 次检测到异常才退出（避免偶发抖动误杀）
//   - IsDebuggerPresent 在安全软件注入环境下可能误报，改用连续检测

use std::sync::atomic::{AtomicU32, Ordering};
use std::thread;
use std::time::Duration;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::time::Instant;

/// 连续检测到异常的次数阈值，达到此值才退出
const STRIKE_LIMIT: u32 = 3;

static STRIKE_COUNT: AtomicU32 = AtomicU32::new(0);

/// 启动反调试巡逻线程。应在 app 初始化后尽早调用。
pub fn start_patrol() {
    thread::spawn(|| {
        loop {
            if check_debugger() || check_timing_anomaly() {
                let strikes = STRIKE_COUNT.fetch_add(1, Ordering::SeqCst) + 1;
                eprintln!("[antidebug] 异常检测 strike {}/{}", strikes, STRIKE_LIMIT);
                if strikes >= STRIKE_LIMIT {
                    // 先还原 IDE 配置，避免代理端口残留
                    let _ = crate::commands::ide_config::restore("windsurf");
                    let _ = crate::commands::ide_config::restore("devin");
                    let _ = crate::commands::workbench_inject::restore("windsurf");
                    let _ = crate::commands::workbench_inject::restore("devin");
                    std::process::exit(1);
                }
            } else {
                // 正常时重置计数
                STRIKE_COUNT.store(0, Ordering::SeqCst);
            }
            thread::sleep(Duration::from_secs(2));
        }
    });
}

// ─── Windows ────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn check_debugger() -> bool {
    use windows_sys::Win32::System::Diagnostics::Debug::IsDebuggerPresent;
    unsafe { IsDebuggerPresent() != 0 }
}

#[cfg(target_os = "windows")]
fn check_timing_anomaly() -> bool {
    use windows_sys::Win32::System::Performance::QueryPerformanceCounter;
    use windows_sys::Win32::System::Performance::QueryPerformanceFrequency;

    unsafe {
        let mut freq: i64 = 0;
        QueryPerformanceFrequency(&mut freq);
        if freq == 0 {
            return false;
        }

        // 1 秒阈值：正常负载波动不会超过，调试器断点会导致秒级暂停
        let threshold_ticks = freq;

        let mut t1: i64 = 0;
        let mut t2: i64 = 0;
        QueryPerformanceCounter(&mut t1);
        let _ = std::hint::black_box(0u64.wrapping_add(1));
        QueryPerformanceCounter(&mut t2);

        let delta = t2.saturating_sub(t1);
        delta > threshold_ticks
    }
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
pub fn clear_hardware_breakpoints() {
    #[repr(C, align(16))]
    struct X86_64Context {
        p1_home: u64,
        p2_home: u64,
        p3_home: u64,
        p4_home: u64,
        p5_home: u64,
        p6_home: u64,
        ctx_flags: u32,
        mx_csr: u32,
        seg_cs: u16,
        seg_ds: u16,
        seg_es: u16,
        seg_fs: u16,
        seg_gs: u16,
        seg_ss: u16,
        e_flags: u32,
        dr0: u64,
        dr1: u64,
        dr2: u64,
        dr3: u64,
        dr6: u64,
        dr7: u64,
        rax: u64,
        rcx: u64,
        rdx: u64,
        rbx: u64,
        rsp: u64,
        rbp: u64,
        rsi: u64,
        rdi: u64,
        r8: u64,
        r9: u64,
        r10: u64,
        r11: u64,
        r12: u64,
        r13: u64,
        r14: u64,
        r15: u64,
        rip: u64,
        flt_save: [u8; 512],
        vector_register: [u8; 416],
        vector_control: u64,
        debug_control: u64,
        last_branch_to_rip: u64,
        last_branch_from_rip: u64,
        last_exception_to_rip: u64,
        last_exception_from_rip: u64,
    }

    extern "system" {
        fn GetCurrentThread() -> isize;
        fn GetThreadContext(thread: isize, ctx: *mut X86_64Context) -> i32;
        fn SetThreadContext(thread: isize, ctx: *const X86_64Context) -> i32;
    }

    unsafe {
        let handle = GetCurrentThread();
        let mut ctx: X86_64Context = std::mem::zeroed();
        ctx.ctx_flags = 0x00100010; // CONTEXT_DEBUG_REGISTERS | CONTEXT_AMD64
        if GetThreadContext(handle, &mut ctx) != 0 {
            ctx.dr0 = 0;
            ctx.dr1 = 0;
            ctx.dr2 = 0;
            ctx.dr3 = 0;
            ctx.dr7 = 0;
            let _ = SetThreadContext(handle, &ctx);
        }
    }
}

#[cfg(all(target_os = "windows", not(target_arch = "x86_64")))]
pub fn clear_hardware_breakpoints() {}

// ─── macOS ──────────────────────────────────────────────────
// 通过 sysctl KERN_PROC 检查 P_TRACED 标志位

#[cfg(target_os = "macos")]
fn check_debugger() -> bool {
    use std::mem;
    unsafe {
        // KERN_PROC = 14, KERN_PROC_PID = 1
        let mut info: libc::kinfo_proc = mem::zeroed();
        let mut size = mem::size_of::<libc::kinfo_proc>();
        let mut mib: [libc::c_int; 4] = [libc::CTL_KERN, 14, 1, libc::getpid()];

        let ret = libc::sysctl(
            mib.as_mut_ptr(),
            4,
            &mut info as *mut _ as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        );
        if ret == 0 {
            // P_TRACED = 0x00000800
            (info.kp_proc.p_flag & 0x00000800) != 0
        } else {
            false
        }
    }
}

#[cfg(target_os = "macos")]
fn check_timing_anomaly() -> bool {
    let start = Instant::now();
    let _ = std::hint::black_box(0u64.wrapping_add(1));
    start.elapsed() > Duration::from_secs(1)
}

#[cfg(target_os = "macos")]
pub fn clear_hardware_breakpoints() {
    // macOS 硬件断点通过 thread_set_state 清除，需要更复杂的 Mach API 调用
    // 此处留空，macOS 反调试主要依赖 P_TRACED 检测
}

// ─── Linux ──────────────────────────────────────────────────
// 通过 /proc/self/status 读取 TracerPid 检测调试器
// 注意：ptrace(PTRACE_TRACEME) 只能成功调用一次，不适合巡逻线程重复调用

#[cfg(target_os = "linux")]
fn check_debugger() -> bool {
    // 读取 /proc/self/status 中的 TracerPid 字段
    // TracerPid: 0 表示无调试器，非 0 表示被 PID 为该值的进程 trace
    if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
        for line in status.lines() {
            if line.starts_with("TracerPid:") {
                let pid_str = line.split(':').nth(1).unwrap_or("").trim();
                return pid_str != "0";
            }
        }
    }
    false
}

#[cfg(target_os = "linux")]
fn check_timing_anomaly() -> bool {
    let start = Instant::now();
    let _ = std::hint::black_box(0u64.wrapping_add(1));
    start.elapsed() > Duration::from_secs(1)
}

#[cfg(target_os = "linux")]
pub fn clear_hardware_breakpoints() {
    // Linux 硬件断点通过 ptrace(PTRACE_POKEUSER) 清除 DR 寄存器
    // 此处留空，Linux 反调试主要依赖 /proc/self/status TracerPid 检测
}
