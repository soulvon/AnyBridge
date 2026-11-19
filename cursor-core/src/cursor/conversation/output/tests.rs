use super::commits::checkpoint_context_tokens;
use super::injections::accept_tool_completion;
    use crate::{cursor::protocol::proto::agent::v1 as pb, run::CommandResult, Error};

    #[test]
    fn compacted_checkpoint_replaces_the_in_memory_context_usage() {
        let compacted = pb::ConversationStateStructure {
            token_details: Some(pb::ConversationTokenDetails {
                used_tokens: 20_000,
                ..Default::default()
            }),
            ..Default::default()
        };

        assert_eq!(checkpoint_context_tokens(&compacted), Some(20_000));
        assert_eq!(
            checkpoint_context_tokens(&pb::ConversationStateStructure::default()),
            None
        );
    }

    #[test]
    fn closing_and_ended_runs_ignore_known_tool_completions() {
        for delivery in [CommandResult::RunClosing, CommandResult::RunEnded] {
            assert!(!accept_tool_completion(delivery, "request", "run", "call").unwrap());
        }
    }

    #[test]
    fn stale_target_remains_an_error() {
        assert!(matches!(
            accept_tool_completion(CommandResult::StaleTarget, "request", "run", "call"),
            Err(Error::RunNotFound(request_id)) if request_id == "request"
        ));
    }
