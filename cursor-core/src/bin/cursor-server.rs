//! Starts the Cursor BYOK server executable.
use cursor_server::{App, Config, Result};
use tracing_subscriber::prelude::*;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "anybridge_cursor_core=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    App::new(Config::from_env()?).await?.serve().await
}
