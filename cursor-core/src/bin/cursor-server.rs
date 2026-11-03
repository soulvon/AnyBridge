//! Starts the Cursor BYOK server executable.
use cursor_server::{logging, App, Config, Result};
use tracing_subscriber::prelude::*;

/// 把 tracing 输出写到 `$ANYBRIDGE_CONFIG_DIR/cursor-core.log`。
///
/// 为什么需要：core 的 stdout 被桌面端接走转发到 UI 面板，进程外部拿不到；
/// 排查接入失败（TLS / 路由 / 上游）时必须能离线读阶段日志。
///
/// 为什么必须轮转：MITM 链路每次建连打 3-5 行，无轮转时用户实测涨到 37 GB
/// （见 [`logging`] 模块头注释）。日志文件由 `logging::RotatingLog` 统一管理。
#[derive(Clone)]
struct FileMakeWriter(std::sync::Arc<std::sync::Mutex<logging::RotatingLog>>);

struct FileGuard(std::sync::Arc<std::sync::Mutex<logging::RotatingLog>>);

impl std::io::Write for FileGuard {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self.0.lock() {
            Ok(mut log) => log.write_bytes(buf).map(|_| buf.len()),
            Err(_) => Ok(buf.len()),
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        match self.0.lock() {
            Ok(mut log) => log.flush(),
            Err(_) => Ok(()),
        }
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for FileMakeWriter {
    type Writer = FileGuard;
    fn make_writer(&'a self) -> Self::Writer {
        FileGuard(self.0.clone())
    }
}

fn init_tracing() {
    let filter = || {
        tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| logging::filter_directive().into())
    };

    let log_path = std::env::var("ANYBRIDGE_CONFIG_DIR")
        .ok()
        .filter(|dir| !dir.trim().is_empty())
        .map(|dir| std::path::Path::new(&dir).join("cursor-core.log"));

    if let Some(path) = log_path {
        if let Ok(log) = logging::RotatingLog::open(&path) {
            let writer = FileMakeWriter(std::sync::Arc::new(std::sync::Mutex::new(log)));
            tracing_subscriber::registry()
                .with(filter())
                .with(tracing_subscriber::fmt::layer().with_writer(writer))
                .init();
            return;
        }
    }

    tracing_subscriber::registry()
        .with(filter())
        .with(tracing_subscriber::fmt::layer())
        .init();
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    App::new(Config::from_env()?).await?.serve().await
}
