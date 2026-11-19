//! 统一文件原子写工具：PID + 纳秒时间戳 + 原子自增序数，杜绝同目录临时文件碰撞。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::Result;

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// 生成同目录唯一临时路径：`{prefix}{name}.{pid}.{nanos}.{seq}.tmp`。
pub fn unique_tmp_path(target: &Path, prefix: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    target.with_file_name(format!(
        "{prefix}{name}.{}.{nanos}.{seq}.tmp",
        std::process::id()
    ))
}

/// 原子写文件（带可选 Unix 权限设置与落盘 sync_all + Windows 瞬时锁重试）。
pub fn write_atomic_with_mode(path: &Path, bytes: &[u8], mode: Option<u32>) -> Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let temporary = unique_tmp_path(path, ".");

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if let Some(unix_mode) = mode {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(unix_mode);
    }
    #[cfg(not(unix))]
    let _ = mode;

    let mut file = options.open(&temporary)?;
    if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    drop(file);

    let mut last_err = None;
    for attempt in 0..3u32 {
        match fs::rename(&temporary, path) {
            Ok(()) => {
                #[cfg(unix)]
                if let Some(unix_mode) = mode {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(path, fs::Permissions::from_mode(unix_mode))?;
                }
                return Ok(());
            }
            Err(error) => {
                last_err = Some(error);
                if attempt < 2 {
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
    let _ = fs::remove_file(&temporary);
    Err(last_err.expect("rename failed without error").into())
}

/// 默认权限原子写（同目录唯一临时文件 + 落盘 + rename）。
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    write_atomic_with_mode(path, bytes, None)
}
