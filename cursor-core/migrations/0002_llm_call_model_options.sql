-- Persist the effective Cursor model options for each local provider call.
ALTER TABLE llm_calls ADD COLUMN reasoning_effort TEXT;
ALTER TABLE llm_calls ADD COLUMN fast INTEGER NOT NULL DEFAULT 0 CHECK (fast IN (0, 1));
