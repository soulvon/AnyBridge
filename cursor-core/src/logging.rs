//! 进程日志的落盘与轮转。
//!
//! 为什么需要轮转：2026-11-03 有用户报告 `cursor-core.log` 涨到 **37 GB**。
//! 原实现只用 `append(true)` 打开文件，永不切分；而 MITM 链路每建立一次
//! 连接就会打 3-5 行（hudsucker 的证书缓存命中 + cursor_relay 的
//! connect / tls / http 打点），Cursor 的心跳与遥测让日志以每天数 GB 增长。
//!
//! 三层保护：
//! 1. 单文件超过 [`MAX_LOG_BYTES`] 就切到 `.1`（只保留一份历史）；
//! 2. 启动时存量超过 [`RESET_ON_START_BYTES`] 直接截断——历史上不限长可能
//!    已经堆到几十 GB，改名保留会继续白占磁盘；
//! 3. 默认把 hudsucker 降到 `warn`（debug 是主要噪音源），需要排障时用
//!    环境变量 `ANYBRIDGE_LOG_LEVEL=debug` 打开。

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// 单文件上限：超过即轮转为 `.1`。
pub const MAX_LOG_BYTES: u64 = 20 * 1024 * 1024;
/// 启动时存量超过此值直接截断，不保留历史。
pub const RESET_ON_START_BYTES: u64 = 64 * 1024 * 1024;
/// 默认过滤指令：hudsucker 默认只报 warn（其 TLS / 连接错误本身是 ERROR 级，
/// 仍会保留）；cursor_relay 的接入打点保持 info。
pub const DEFAULT_FILTER: &str =
    "cursor_server=info,anybridge_cursor_core=info,cursor_relay=info,hudsucker=warn";

/// 解析实际使用的过滤指令：`ANYBRIDGE_LOG_LEVEL` 非空时整体覆盖（排障用）。
pub fn filter_directive() -> String {
    let override_level = std::env::var("ANYBRIDGE_LOG_LEVEL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    match override_level {
        Some(level) => format!(
            "cursor_server={level},anybridge_cursor_core={level},cursor_relay={level},hudsucker={level}"
        ),
        None => DEFAULT_FILTER.to_string(),
    }
}

fn backup_path(path: &Path) -> PathBuf {
    let mut raw = path.to_path_buf().into_os_string();
    raw.push(".1");
    PathBuf::from(raw)
}

/// 按大小轮转的日志文件。任何一次轮转失败都不会影响主流程（日志不该拖垮服务）。
pub struct RotatingLog {
    path: PathBuf,
    file: Option<File>,
    written: u64,
    max_bytes: u64,
}

impl RotatingLog {
    pub fn open(path: impl AsRef<Path>) -> std::io::Result<Self> {
        Self::open_with_limits(path, MAX_LOG_BYTES, RESET_ON_START_BYTES)
    }

    pub fn open_with_limits(
        path: impl AsRef<Path>,
        max_bytes: u64,
        reset_on_start: u64,
    ) -> std::io::Result<Self> {
        let path = path.as_ref().to_path_buf();
        let existing = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        let truncated = existing > reset_on_start;
        let file = if truncated {
            OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&path)?
        } else {
            OpenOptions::new().create(true).append(true).open(&path)?
        };
        Ok(Self {
            path,
            file: Some(file),
            written: if truncated { 0 } else { existing },
            max_bytes,
        })
    }

    /// 当前文件已写入字节数（测试与诊断用）。
    pub fn written(&self) -> u64 {
        self.written
    }

    fn reopen(&mut self) {
        self.file = OpenOptions::new().create(true).append(true).open(&self.path).ok();
    }

    /// 关句柄 → 旧文件改名 `.1` → 重开新文件。
    /// Windows 上被打开的文件不能改名，所以必须先放手句柄。
    fn rotate(&mut self) {
        if let Some(file) = self.file.take() {
            drop(file);
        }
        let backup = backup_path(&self.path);
        let _ = std::fs::remove_file(&backup);
        let _ = std::fs::rename(&self.path, &backup);
        self.reopen();
        self.written = 0;
    }

    pub fn write_bytes(&mut self, buf: &[u8]) -> std::io::Result<()> {
        if self.written > 0
            && self.written.saturating_add(buf.len() as u64) > self.max_bytes
        {
            self.rotate();
        }
        if self.file.is_none() {
            self.reopen();
        }
        let Some(file) = self.file.as_mut() else {
            // 连文件都打不开时丢弃该行：日志故障不允许影响服务
            return Ok(());
        };
        file.write_all(buf)?;
        self.written = self.written.saturating_add(buf.len() as u64);
        Ok(())
    }

    pub fn flush(&mut self) -> std::io::Result<()> {
        match self.file.as_mut() {
            Some(file) => file.flush(),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "anybridge-logging-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn read(path: &Path) -> String {
        let mut text = String::new();
        std::fs::File::open(path)
            .and_then(|mut file| file.read_to_string(&mut text))
            .map(|_| text)
            .unwrap_or_default()
    }

    #[test]
    fn rotates_when_exceeding_max_bytes_and_keeps_one_backup() {
        let dir = temp_dir("rotate");
        let path = dir.join("cursor-core.log");
        let mut log = RotatingLog::open_with_limits(&path, 64, u64::MAX).expect("open");

        log.write_bytes(b"first-line\n").expect("write");
        // 第一段未超限：仍在主文件
        assert_eq!(read(&path), "first-line\n");

        // 超过 64 字节触发轮转：旧内容进 .1，主文件重新开始
        log.write_bytes(&vec![b'x'; 64]).expect("write big");
        assert_eq!(read(&path), "x".repeat(64));
        assert_eq!(read(&backup_path(&path)), "first-line\n");
        assert_eq!(log.written(), 64);

        // 再超一次：备份被覆盖（只保留一份历史）
        log.write_bytes(&vec![b'y'; 64]).expect("write big again");
        assert_eq!(read(&backup_path(&path)), "x".repeat(64));
        assert_eq!(read(&path), "y".repeat(64));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn oversized_existing_file_is_truncated_on_open() {
        let dir = temp_dir("truncate");
        let path = dir.join("cursor-core.log");
        std::fs::write(&path, vec![b'z'; 4096]).expect("seed");

        let mut log = RotatingLog::open_with_limits(&path, 1024, 2048).expect("open");

        // 存量 4096 > 重置阈值 2048：启动即清空，不保留历史
        assert_eq!(std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0), 0);
        assert_eq!(log.written(), 0);
        log.write_bytes(b"fresh\n").expect("write");
        assert_eq!(read(&path), "fresh\n");
        assert!(!backup_path(&path).exists(), "截断不产生备份文件");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn filter_defaults_to_warn_for_hudsucker_and_accepts_override() {
        assert!(DEFAULT_FILTER.contains("hudsucker=warn"));
        let previous = std::env::var("ANYBRIDGE_LOG_LEVEL").ok();
        std::env::remove_var("ANYBRIDGE_LOG_LEVEL");
        assert_eq!(filter_directive(), DEFAULT_FILTER);

        std::env::set_var("ANYBRIDGE_LOG_LEVEL", "debug");
        assert!(filter_directive().contains("hudsucker=debug"));
        match previous {
            Some(value) => std::env::set_var("ANYBRIDGE_LOG_LEVEL", value),
            None => std::env::remove_var("ANYBRIDGE_LOG_LEVEL"),
        }
    }
}
