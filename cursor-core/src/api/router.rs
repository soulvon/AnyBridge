//! Builds the top-level server router.

use crate::{cursor::transport::TransportRegistry, network::NetworkClients, Result};

pub fn router(registry: TransportRegistry, clients: NetworkClients) -> Result<axum::Router> {
    super::cursor::router(registry, clients)
}
