-- Cursor may reuse one transport request id for multiple queued executions.
-- Keep that id as an association key while each local Run keeps its own identity.
ALTER TABLE runs ADD COLUMN cursor_request_id TEXT;

CREATE INDEX idx_runs_cursor_request_active
ON runs(cursor_request_id, status, created_at_ms DESC);
