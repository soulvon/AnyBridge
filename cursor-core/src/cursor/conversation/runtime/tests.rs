use crate::cursor::protocol::proto::agent::v1 as pb;

use super::actions::runtime_action_name;

#[test]
fn runtime_action_name_maps_expected_variants() {
    assert_eq!(
        runtime_action_name(&pb::conversation_action::Action::CancelAction(
            pb::CancelAction::default()
        )),
        "CancelAction"
    );
    assert_eq!(
        runtime_action_name(&pb::conversation_action::Action::ResumeAction(
            pb::ResumeAction::default()
        )),
        "ResumeAction"
    );
    assert_eq!(
        runtime_action_name(&pb::conversation_action::Action::UserMessageAction(
            pb::UserMessageAction::default()
        )),
        "UserMessageAction"
    );
}
