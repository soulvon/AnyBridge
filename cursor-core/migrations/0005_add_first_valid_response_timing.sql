ALTER TABLE llm_calls ADD COLUMN first_valid_response_at_ms INTEGER;
ALTER TABLE llm_calls ADD COLUMN ttfr_ms INTEGER;
