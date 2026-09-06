-- Renames persisted Conversation history terminology without changing identities or data.
ALTER TABLE conversation_revisions RENAME TO conversation_checkpoints;
ALTER TABLE conversation_checkpoints RENAME COLUMN revision_id TO checkpoint_id;
ALTER TABLE conversation_checkpoints RENAME COLUMN parent_revision_id TO parent_checkpoint_id;

ALTER TABLE revision_messages RENAME TO checkpoint_messages;
ALTER TABLE checkpoint_messages RENAME COLUMN revision_id TO checkpoint_id;

ALTER TABLE conversations RENAME COLUMN current_revision_id TO current_checkpoint_id;
ALTER TABLE runs RENAME COLUMN base_revision_id TO base_checkpoint_id;
ALTER TABLE runs RENAME COLUMN head_revision_id TO head_checkpoint_id;
ALTER TABLE tool_rounds RENAME COLUMN base_revision_id TO base_checkpoint_id;
ALTER TABLE tool_round_calls RENAME COLUMN committed_revision_id TO committed_checkpoint_id;
ALTER TABLE input_anchors RENAME COLUMN base_revision_id TO base_checkpoint_id;

DROP INDEX conversation_revisions_parent;
CREATE INDEX conversation_checkpoints_parent
ON conversation_checkpoints(conversation_id, parent_checkpoint_id);
