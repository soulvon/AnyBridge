//! Coordinates append admission with transport shutdown.

use std::sync::Arc;

use tokio::sync::Notify;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TransportState {
    Open,
    Closing,
    Draining,
    Closed,
}

#[derive(Clone)]
pub(crate) struct TransportLifecycle {
    inner: Arc<LifecycleInner>,
}

struct LifecycleInner {
    state: parking_lot::Mutex<LifecycleState>,
    admissions_drained: Notify,
    closed: Notify,
}

struct LifecycleState {
    state: TransportState,
    admissions: usize,
}

pub(crate) struct TransportAdmission {
    inner: Arc<LifecycleInner>,
}

impl TransportLifecycle {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(LifecycleInner {
                state: parking_lot::Mutex::new(LifecycleState {
                    state: TransportState::Open,
                    admissions: 0,
                }),
                admissions_drained: Notify::new(),
                closed: Notify::new(),
            }),
        }
    }

    pub(crate) fn is_open(&self) -> bool {
        self.inner.state.lock().state == TransportState::Open
    }

    pub(crate) fn admit(&self) -> Option<TransportAdmission> {
        let mut lifecycle = self.inner.state.lock();
        if lifecycle.state != TransportState::Open {
            return None;
        }
        lifecycle.admissions += 1;
        Some(TransportAdmission {
            inner: self.inner.clone(),
        })
    }

    pub(crate) fn begin_close(&self) {
        let mut lifecycle = self.inner.state.lock();
        if lifecycle.state != TransportState::Open {
            return;
        }
        lifecycle.state = TransportState::Closing;
        let drained = lifecycle.admissions == 0;
        drop(lifecycle);
        if drained {
            self.inner.admissions_drained.notify_waiters();
        }
    }

    pub(crate) fn admissions_drained(&self) -> bool {
        self.inner.state.lock().admissions == 0
    }

    pub(crate) async fn wait_admissions_drained(&self) {
        loop {
            let notified = self.inner.admissions_drained.notified();
            if self.inner.state.lock().admissions == 0 {
                return;
            }
            notified.await;
        }
    }

    pub(crate) fn mark_draining(&self) {
        let mut lifecycle = self.inner.state.lock();
        if lifecycle.state == TransportState::Closing && lifecycle.admissions == 0 {
            lifecycle.state = TransportState::Draining;
        }
    }

    pub(crate) fn reopen(&self) {
        let mut lifecycle = self.inner.state.lock();
        if matches!(
            lifecycle.state,
            TransportState::Closing | TransportState::Draining
        ) {
            lifecycle.state = TransportState::Open;
        }
    }

    pub(crate) fn close(&self) {
        let mut lifecycle = self.inner.state.lock();
        if lifecycle.state == TransportState::Closed {
            return;
        }
        lifecycle.state = TransportState::Closed;
        drop(lifecycle);
        self.inner.closed.notify_waiters();
    }

    pub(crate) async fn wait_closed(&self) {
        loop {
            let notified = self.inner.closed.notified();
            if self.inner.state.lock().state == TransportState::Closed {
                return;
            }
            notified.await;
        }
    }
}

impl Drop for TransportAdmission {
    fn drop(&mut self) {
        let mut lifecycle = self.inner.state.lock();
        lifecycle.admissions = lifecycle.admissions.saturating_sub(1);
        let drained = lifecycle.state == TransportState::Closing && lifecycle.admissions == 0;
        drop(lifecycle);
        if drained {
            self.inner.admissions_drained.notify_waiters();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{TransportLifecycle, TransportState};

    #[tokio::test]
    async fn closing_waits_for_existing_admissions() {
        let lifecycle = TransportLifecycle::new();
        let admission = lifecycle.admit().unwrap();
        lifecycle.begin_close();
        assert!(lifecycle.admit().is_none());
        drop(admission);
        lifecycle.wait_admissions_drained().await;
        lifecycle.mark_draining();
        assert_eq!(lifecycle.inner.state.lock().state, TransportState::Draining);
    }

    #[tokio::test]
    async fn an_admitted_continuation_reopens_the_transport() {
        let lifecycle = TransportLifecycle::new();
        let admission = lifecycle.admit().unwrap();
        lifecycle.begin_close();
        drop(admission);
        lifecycle.wait_admissions_drained().await;
        lifecycle.mark_draining();
        lifecycle.reopen();

        assert_eq!(lifecycle.inner.state.lock().state, TransportState::Open);
        assert!(lifecycle.admit().is_some());
    }
}
