//! Defines retry policy for one logical model call.

use std::time::Duration;

use super::ModelCycleFailure;

pub(super) const MAX_MODEL_RETRIES: u32 = 8;
pub(super) const MODEL_RETRY_DELAY: Duration = Duration::from_secs(5);

pub(super) fn should_retry(failure: &ModelCycleFailure, retries: u32) -> bool {
    failure.retryable && retries < MAX_MODEL_RETRIES
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::{ModelCycleFailure, RunFailure};

    fn failure(retryable: bool) -> ModelCycleFailure {
        ModelCycleFailure {
            failure: RunFailure::Provider("failed".into()),
            partial_text: String::new(),
            partial_reasoning: String::new(),
            usage: None,
            retryable,
        }
    }

    #[test]
    fn permits_eight_retries_after_the_initial_attempt() {
        let retryable = failure(true);
        for retries in 0..MAX_MODEL_RETRIES {
            assert!(should_retry(&retryable, retries));
        }
        assert!(!should_retry(&retryable, MAX_MODEL_RETRIES));
    }

    #[test]
    fn terminal_failures_never_retry() {
        assert!(!should_retry(&failure(false), 0));
    }
}
