//! Normalizes provider-specific responses.
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::model::{normalize_provider_tool_call_ids, ModelInvocation};

use super::{Provider, ProviderStream};

pub(super) struct NormalizedProvider {
    inner: Arc<dyn Provider>,
}

impl NormalizedProvider {
    pub(super) fn new(inner: Arc<dyn Provider>) -> Self {
        Self { inner }
    }
}

impl Provider for NormalizedProvider {
    fn stream(
        &self,
        mut invocation: ModelInvocation,
        cancellation: CancellationToken,
    ) -> ProviderStream {
        normalize_provider_tool_call_ids(&mut invocation.request.history);
        self.inner.stream(invocation, cancellation)
    }
}
