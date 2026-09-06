PRAGMA defer_foreign_keys = ON;

CREATE TABLE model_configs (
    model_hash TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL DEFAULT 0,
    display_name TEXT NOT NULL,
    model_type TEXT NOT NULL CHECK(model_type IN ('openai', 'anthropic')),
    base_url TEXT NOT NULL,
    use_full_url INTEGER NOT NULL DEFAULT 0 CHECK(use_full_url IN (0, 1)),
    api_key TEXT NOT NULL,
    tooltip_data TEXT NOT NULL,
    model_id TEXT NOT NULL,
    reasoning_effort TEXT,
    openai_endpoint TEXT NOT NULL DEFAULT '',
    openai_extra_params_enabled INTEGER NOT NULL DEFAULT 0 CHECK(openai_extra_params_enabled IN (0, 1)),
    openai_extra_params_json TEXT NOT NULL DEFAULT '{}',
    custom_headers_enabled INTEGER NOT NULL DEFAULT 0 CHECK(custom_headers_enabled IN (0, 1)),
    custom_headers_json TEXT NOT NULL DEFAULT '{}',
    anthropic_extra_params_enabled INTEGER NOT NULL DEFAULT 0 CHECK(anthropic_extra_params_enabled IN (0, 1)),
    anthropic_extra_params_json TEXT NOT NULL DEFAULT '{}',
    context_window_tokens INTEGER,
    max_completion_tokens INTEGER,
    anthropic_max_tokens INTEGER,
    anthropic_thinking_effort TEXT,
    thinking_budget_tokens INTEGER,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

INSERT INTO model_configs (
    model_hash,
    sort_order,
    display_name,
    model_type,
    base_url,
    use_full_url,
    api_key,
    tooltip_data,
    model_id,
    reasoning_effort,
    openai_endpoint,
    openai_extra_params_enabled,
    openai_extra_params_json,
    custom_headers_enabled,
    custom_headers_json,
    anthropic_extra_params_enabled,
    anthropic_extra_params_json,
    context_window_tokens,
    max_completion_tokens,
    anthropic_max_tokens,
    anthropic_thinking_effort,
    thinking_budget_tokens,
    created_at_ms,
    updated_at_ms
)
SELECT
    model.model_hash,
    model.sort_order,
    model.display_name,
    CASE model.endpoint_type WHEN 'anthropic' THEN 'anthropic' ELSE 'openai' END,
    CASE
        WHEN model.request_url = '' THEN endpoint.base_url
        WHEN model.request_url LIKE 'http://%' OR model.request_url LIKE 'https://%' THEN model.request_url
        ELSE replace(rtrim(endpoint.base_url, '/') || '/' || ltrim(model.request_url, '/'), '/v1/v1/', '/v1/')
    END,
    CASE WHEN model.request_url = '' THEN 0 ELSE 1 END,
    endpoint.api_key,
    model.display_name,
    model.model_id,
    CASE
        WHEN model.endpoint_type != 'anthropic' AND model.reasoning_enabled = 1
            THEN COALESCE(NULLIF(trim(model.reasoning_effort), ''), 'medium')
        ELSE NULL
    END,
    CASE model.endpoint_type
        WHEN 'openai-responses' THEN '/v1/responses'
        WHEN 'openai-chat' THEN '/v1/chat/completions'
        ELSE ''
    END,
    CASE WHEN model.endpoint_type != 'anthropic' AND endpoint.extra_params_json != '{}' THEN 1 ELSE 0 END,
    CASE WHEN model.endpoint_type != 'anthropic' THEN endpoint.extra_params_json ELSE '{}' END,
    CASE WHEN endpoint.custom_headers_json != '{}' THEN 1 ELSE 0 END,
    endpoint.custom_headers_json,
    CASE WHEN model.endpoint_type = 'anthropic' AND endpoint.extra_params_json != '{}' THEN 1 ELSE 0 END,
    CASE WHEN model.endpoint_type = 'anthropic' THEN endpoint.extra_params_json ELSE '{}' END,
    model.context_window_tokens,
    CASE WHEN model.endpoint_type != 'anthropic' THEN model.max_output_tokens ELSE NULL END,
    CASE WHEN model.endpoint_type = 'anthropic' THEN model.max_output_tokens ELSE NULL END,
    CASE WHEN model.endpoint_type = 'anthropic' THEN 'xhigh' ELSE NULL END,
    NULL,
    model.created_at_ms,
    model.updated_at_ms
FROM provider_models AS model
JOIN provider_endpoints AS endpoint ON endpoint.provider_id = model.provider_id;

CREATE TABLE llm_calls_new (
    call_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    provider_call_index INTEGER NOT NULL,
    model_hash TEXT,
    provider_type TEXT NOT NULL,
    provider_url TEXT NOT NULL,
    request_type TEXT NOT NULL,
    request_url TEXT NOT NULL,
    model_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL,
    finish_reason TEXT,
    created_at_ms INTEGER NOT NULL,
    request_started_at_ms INTEGER,
    response_headers_at_ms INTEGER,
    first_event_at_ms INTEGER,
    first_text_at_ms INTEGER,
    finished_at_ms INTEGER,
    queue_ms INTEGER,
    ttfb_ms INTEGER,
    ttft_ms INTEGER,
    duration_ms INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    reasoning_tokens INTEGER,
    usage_json TEXT,
    message_count INTEGER NOT NULL,
    tool_count INTEGER NOT NULL,
    request_bytes INTEGER,
    response_bytes INTEGER NOT NULL DEFAULT 0,
    stream_event_count INTEGER NOT NULL DEFAULT 0,
    http_status INTEGER,
    error_kind TEXT,
    error_message TEXT,
    detailed INTEGER NOT NULL,
    reasoning_effort TEXT,
    fast INTEGER NOT NULL DEFAULT 0 CHECK (fast IN (0, 1)),
    FOREIGN KEY(model_hash) REFERENCES model_configs(model_hash)
);

INSERT INTO llm_calls_new (
    call_id, run_id, conversation_id, provider_call_index, model_hash, provider_type,
    provider_url, request_type, request_url, model_id, display_name, status, finish_reason,
    created_at_ms, request_started_at_ms, response_headers_at_ms, first_event_at_ms,
    first_text_at_ms, finished_at_ms, queue_ms, ttfb_ms, ttft_ms, duration_ms,
    input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens,
    reasoning_tokens, usage_json, message_count, tool_count, request_bytes, response_bytes,
    stream_event_count, http_status, error_kind, error_message, detailed, reasoning_effort, fast
)
SELECT
    call_id, run_id, conversation_id, provider_call_index, model_hash, provider_type,
    provider_url, request_type, request_url, model_id, display_name, status, finish_reason,
    created_at_ms, request_started_at_ms, response_headers_at_ms, first_event_at_ms,
    first_text_at_ms, finished_at_ms, queue_ms, ttfb_ms, ttft_ms, duration_ms,
    input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens,
    reasoning_tokens, usage_json, message_count, tool_count, request_bytes, response_bytes,
    stream_event_count, http_status, error_kind, error_message, detailed, reasoning_effort, fast
FROM llm_calls;

CREATE TABLE llm_call_requests_new (
    call_id TEXT PRIMARY KEY,
    headers_json TEXT NOT NULL,
    body_json TEXT NOT NULL,
    byte_count INTEGER NOT NULL,
    FOREIGN KEY(call_id) REFERENCES llm_calls_new(call_id) ON DELETE CASCADE
);

INSERT INTO llm_call_requests_new(call_id, headers_json, body_json, byte_count)
SELECT call_id, headers_json, body_json, byte_count FROM llm_call_requests;

CREATE TABLE llm_call_response_chunks_new (
    call_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    received_offset_ms INTEGER NOT NULL,
    data BLOB NOT NULL,
    byte_count INTEGER NOT NULL,
    PRIMARY KEY(call_id, seq),
    FOREIGN KEY(call_id) REFERENCES llm_calls_new(call_id) ON DELETE CASCADE
);

INSERT INTO llm_call_response_chunks_new(call_id, seq, received_offset_ms, data, byte_count)
SELECT call_id, seq, received_offset_ms, data, byte_count FROM llm_call_response_chunks;

DROP TABLE llm_call_requests;
DROP TABLE llm_call_response_chunks;
DROP TABLE llm_calls;
DROP TABLE provider_models;
DROP TABLE provider_endpoints;

ALTER TABLE llm_calls_new RENAME TO llm_calls;
ALTER TABLE llm_call_requests_new RENAME TO llm_call_requests;
ALTER TABLE llm_call_response_chunks_new RENAME TO llm_call_response_chunks;

CREATE INDEX model_configs_sort ON model_configs(sort_order, display_name);
CREATE INDEX llm_calls_created ON llm_calls(created_at_ms DESC);
CREATE INDEX llm_calls_run ON llm_calls(run_id, provider_call_index);
CREATE INDEX llm_calls_model ON llm_calls(model_hash, created_at_ms DESC);
