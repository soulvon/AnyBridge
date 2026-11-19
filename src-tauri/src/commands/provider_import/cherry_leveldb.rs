use crate::commands::config::{ApiFormat, ModelCaps};
use rusqlite::Connection;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use super::*;
pub(super) const CHERRY_PERSIST_KEY: &[u8] = b"persist:cherry-studio";
pub(super) const LEVELDB_LOG_BLOCK_SIZE: usize = 32 * 1024;
pub(super) const LEVELDB_LOG_HEADER_SIZE: usize = 7;
pub(super) const LEVELDB_TABLE_FOOTER_SIZE: usize = 48;
pub(super) const LEVELDB_TABLE_TRAILER_SIZE: usize = 5;
pub(super) const LEVELDB_TABLE_MAGIC: u64 = 0xdb4775248b80fb57;

pub(super) fn cherry_persist_roots_from_leveldb_log(bytes: &[u8]) -> Vec<Value> {
    let mut roots = Vec::new();
    for record in leveldb_log_records(bytes) {
        roots.extend(cherry_persist_roots_from_write_batch(&record));
    }
    roots
}

pub(super) fn cherry_persist_roots_from_leveldb_table(bytes: &[u8]) -> Vec<Value> {
    let mut roots = Vec::new();
    for (key, value) in leveldb_table_entries(bytes) {
        if bytes_contains(&key, CHERRY_PERSIST_KEY) {
            if let Some(root) = parse_cherry_persist_value(&value) {
                roots.push(root);
            }
        }
    }
    roots
}

pub(super) fn leveldb_table_entries(bytes: &[u8]) -> Vec<(Vec<u8>, Vec<u8>)> {
    if bytes.len() < LEVELDB_TABLE_FOOTER_SIZE {
        return Vec::new();
    }

    let magic_offset = bytes.len() - 8;
    if u64::from_le_bytes(bytes[magic_offset..].try_into().unwrap_or([0; 8])) != LEVELDB_TABLE_MAGIC
    {
        return Vec::new();
    }

    let footer = &bytes[bytes.len() - LEVELDB_TABLE_FOOTER_SIZE..];
    let mut pos = 0;
    if leveldb_read_block_handle(footer, &mut pos).is_none() {
        return Vec::new();
    }
    let Some((index_offset, index_size)) = leveldb_read_block_handle(footer, &mut pos) else {
        return Vec::new();
    };
    let Some(index_block) = leveldb_table_block(bytes, index_offset, index_size) else {
        return Vec::new();
    };

    let mut entries = Vec::new();
    for (_, handle_value) in leveldb_block_entries(&index_block) {
        let mut handle_pos = 0;
        let Some((data_offset, data_size)) =
            leveldb_read_block_handle(&handle_value, &mut handle_pos)
        else {
            continue;
        };
        if let Some(data_block) = leveldb_table_block(bytes, data_offset, data_size) {
            entries.extend(leveldb_block_entries(&data_block));
        }
    }
    entries
}

pub(super) fn leveldb_table_block(bytes: &[u8], offset: usize, size: usize) -> Option<Vec<u8>> {
    let trailer_offset = offset.checked_add(size)?;
    let trailer_end = trailer_offset.checked_add(LEVELDB_TABLE_TRAILER_SIZE)?;
    if trailer_end > bytes.len() {
        return None;
    }
    let block = &bytes[offset..trailer_offset];
    match bytes[trailer_offset] {
        0 => Some(block.to_vec()),
        1 => snap::raw::Decoder::new().decompress_vec(block).ok(),
        _ => None,
    }
}

pub(super) fn leveldb_read_block_handle(bytes: &[u8], pos: &mut usize) -> Option<(usize, usize)> {
    let offset = read_varint_usize(bytes, pos)?;
    let size = read_varint_usize(bytes, pos)?;
    Some((offset, size))
}

pub(super) fn leveldb_block_entries(block: &[u8]) -> Vec<(Vec<u8>, Vec<u8>)> {
    let mut entries = Vec::new();
    if block.len() < 4 {
        return entries;
    }

    let restart_count_offset = block.len() - 4;
    let restart_count =
        u32::from_le_bytes(block[restart_count_offset..].try_into().unwrap_or([0; 4])) as usize;
    let Some(restart_table_len) = restart_count.checked_mul(4) else {
        return entries;
    };
    if restart_count_offset < restart_table_len {
        return entries;
    }
    let entries_end = restart_count_offset - restart_table_len;

    let mut pos = 0;
    let mut previous_key: Vec<u8> = Vec::new();
    while pos < entries_end {
        let Some(shared) = read_varint_usize(block, &mut pos) else {
            break;
        };
        let Some(non_shared) = read_varint_usize(block, &mut pos) else {
            break;
        };
        let Some(value_len) = read_varint_usize(block, &mut pos) else {
            break;
        };
        if shared > previous_key.len() {
            break;
        }
        let Some(key_end) = pos.checked_add(non_shared) else {
            break;
        };
        let Some(value_end) = key_end.checked_add(value_len) else {
            break;
        };
        if value_end > entries_end {
            break;
        }

        let mut key = previous_key[..shared].to_vec();
        key.extend_from_slice(&block[pos..key_end]);
        let value = block[key_end..value_end].to_vec();
        previous_key = key.clone();
        entries.push((key, value));
        pos = value_end;
    }
    entries
}

pub(super) fn leveldb_log_records(bytes: &[u8]) -> Vec<Vec<u8>> {
    let mut records = Vec::new();
    let mut partial = Vec::new();
    let mut block_start = 0;

    while block_start < bytes.len() {
        let block_end = (block_start + LEVELDB_LOG_BLOCK_SIZE).min(bytes.len());
        let mut pos = block_start;

        while pos + LEVELDB_LOG_HEADER_SIZE <= block_end {
            let len = u16::from_le_bytes([bytes[pos + 4], bytes[pos + 5]]) as usize;
            let record_type = bytes[pos + 6];
            pos += LEVELDB_LOG_HEADER_SIZE;

            if len == 0 && record_type == 0 {
                break;
            }
            if pos + len > block_end {
                break;
            }

            let data = &bytes[pos..pos + len];
            pos += len;

            match record_type {
                1 => records.push(data.to_vec()),
                2 => {
                    partial.clear();
                    partial.extend_from_slice(data);
                }
                3 => {
                    if !partial.is_empty() {
                        partial.extend_from_slice(data);
                    }
                }
                4 => {
                    if !partial.is_empty() {
                        partial.extend_from_slice(data);
                        records.push(std::mem::take(&mut partial));
                    }
                }
                _ => {}
            }
        }

        block_start += LEVELDB_LOG_BLOCK_SIZE;
    }

    records
}

pub(super) fn cherry_persist_roots_from_write_batch(record: &[u8]) -> Vec<Value> {
    let mut roots = Vec::new();
    if record.len() < 12 {
        return roots;
    }

    let mut pos = 12;
    while pos < record.len() {
        let tag = record[pos];
        pos += 1;

        let Some(key_len) = read_varint_usize(record, &mut pos) else {
            break;
        };
        if pos + key_len > record.len() {
            break;
        }
        let key = &record[pos..pos + key_len];
        pos += key_len;

        match tag {
            0 => {}
            1 => {
                let Some(value_len) = read_varint_usize(record, &mut pos) else {
                    break;
                };
                if pos + value_len > record.len() {
                    break;
                }
                let value = &record[pos..pos + value_len];
                pos += value_len;

                if bytes_contains(key, CHERRY_PERSIST_KEY) {
                    if let Some(root) = parse_cherry_persist_value(value) {
                        roots.push(root);
                    }
                }
            }
            _ => break,
        }
    }

    roots
}

pub(super) fn read_varint_usize(bytes: &[u8], pos: &mut usize) -> Option<usize> {
    let mut value: u64 = 0;
    let mut shift = 0;
    while *pos < bytes.len() && shift <= 63 {
        let byte = bytes[*pos];
        *pos += 1;
        value |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return usize::try_from(value).ok();
        }
        shift += 7;
    }
    None
}

pub(super) fn bytes_contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

pub(super) fn parse_cherry_persist_value(value: &[u8]) -> Option<Value> {
    let json = decode_cherry_local_storage_json(value)?;
    serde_json::from_str(&json).ok().or_else(|| {
        balanced_json_prefix(&json).and_then(|prefix| serde_json::from_str(prefix).ok())
    })
}

pub(super) fn decode_cherry_local_storage_json(value: &[u8]) -> Option<String> {
    if let Some(start) = find_utf16_json_start(value) {
        let units = value[start..]
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        let decoded = String::from_utf16_lossy(&units);
        return Some(decoded.trim_end_matches('\0').to_string());
    }

    let start = value.iter().position(|byte| *byte == b'{')?;
    std::str::from_utf8(&value[start..])
        .ok()
        .map(|s| s.trim_end_matches('\0').to_string())
}

pub(super) fn find_utf16_json_start(value: &[u8]) -> Option<usize> {
    value.windows(2).position(|window| window == [b'{', 0])
}

pub(super) fn balanced_json_prefix(value: &str) -> Option<&str> {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    let mut started = false;

    for (idx, ch) in value.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }

        match ch {
            '"' => in_string = true,
            '{' => {
                depth += 1;
                started = true;
            }
            '}' => {
                depth = depth.saturating_sub(1);
                if started && depth == 0 {
                    return value.get(..idx + ch.len_utf8());
                }
            }
            _ => {}
        }
    }

    None
}

pub(super) fn scan_cherry_persisted_root(
    source_path: &Path,
    root: &Value,
    candidates: &mut Vec<ImportProviderCandidate>,
) {
    let Some(llm) = cherry_llm_state(root) else {
        return;
    };
    let Some(providers) = llm.get("providers").and_then(Value::as_array) else {
        return;
    };

    for provider in providers {
        scan_cherry_persisted_provider(source_path, provider, candidates);
    }
}

pub(super) fn cherry_llm_state(root: &Value) -> Option<Value> {
    match root.get("llm")? {
        Value::String(raw) => serde_json::from_str(raw).ok(),
        value @ Value::Object(_) => Some(value.clone()),
        _ => None,
    }
}

pub(super) fn scan_cherry_persisted_provider(
    source_path: &Path,
    provider: &Value,
    candidates: &mut Vec<ImportProviderCandidate>,
) {
    let provider_id = string_value(provider, "id").unwrap_or_else(|| {
        let mut hasher = Sha256::new();
        hasher.update(provider.to_string().as_bytes());
        format!("cherry-{}", &hex::encode(hasher.finalize())[..12])
    });
    let name = string_value(provider, "name").unwrap_or_else(|| provider_id.clone());
    let Some(api_key) = string_value(provider, "apiKey")
        .or_else(|| string_value(provider, "api_key"))
        .or_else(|| string_value(provider, "key"))
    else {
        return;
    };
    let Some((api_format, wire_api)) = cherry_provider_api_format(provider) else {
        return;
    };
    let Some(base_url) = cherry_provider_base_url(provider, &api_format) else {
        return;
    };

    let (models, model_caps) = cherry_provider_models(provider);
    let vision = model_caps.values().any(|caps| caps.vision);
    let tools = model_caps.values().any(|caps| caps.tools);
    let mut warnings = Vec::new();
    if provider
        .get("enabled")
        .and_then(Value::as_bool)
        .is_some_and(|enabled| !enabled)
    {
        warnings.push("源供应商在 Cherry Studio 中未启用，导入后默认启用".to_string());
    }

    let (api_host, api_path) = normalize_endpoint(&base_url, &api_format, wire_api.as_deref());
    let mut candidate = ImportProviderCandidate {
        id: String::new(),
        source: "Cherry Studio".to_string(),
        source_id: format!("cherry-local:{}", provider_id),
        source_path: source_path.display().to_string(),
        name,
        api_host,
        api_key,
        api_path,
        default_model: models.first().cloned().unwrap_or_default(),
        api_format,
        enabled: true,
        models,
        capabilities: import_caps(vision, tools, false),
        model_caps,
        warnings,
    };
    finalize_candidate(&mut candidate);
    candidates.push(candidate);
}

pub(super) fn cherry_provider_api_format(provider: &Value) -> Option<(ApiFormat, Option<String>)> {
    let provider_type = string_value(provider, "type")
        .unwrap_or_else(|| "openai".to_string())
        .to_ascii_lowercase();
    if provider_type.contains("anthropic") {
        return Some((ApiFormat::Anthropic, None));
    }
    if provider_type.contains("gemini") || provider_type.contains("google") {
        return Some((ApiFormat::Gemini, None));
    }

    let openai_compatible = provider_type.is_empty()
        || provider_type.contains("openai")
        || matches!(
            provider_type.as_str(),
            "new-api" | "ollama" | "lmstudio" | "azure-openai"
        );
    if !openai_compatible {
        return None;
    }

    let wire_api = if provider_type.contains("response") {
        Some("responses".to_string())
    } else {
        None
    };
    Some((ApiFormat::Openai, wire_api))
}

pub(super) fn cherry_provider_base_url(provider: &Value, api_format: &ApiFormat) -> Option<String> {
    let keys: &[&str] = match api_format {
        ApiFormat::Anthropic => &[
            "anthropicApiHost",
            "anthropic_api_host",
            "apiHost",
            "api_host",
            "baseUrl",
            "base_url",
            "url",
        ],
        ApiFormat::Gemini => &[
            "geminiApiHost",
            "gemini_api_host",
            "apiHost",
            "api_host",
            "baseUrl",
            "base_url",
            "url",
        ],
        ApiFormat::Openai => &["apiHost", "api_host", "baseUrl", "base_url", "url"],
    };

    keys.iter()
        .find_map(|key| string_value(provider, key))
        .filter(|value| looks_like_url(value))
}

pub(super) fn cherry_provider_models(provider: &Value) -> (Vec<String>, HashMap<String, ModelCaps>) {
    let mut models = Vec::new();
    let mut model_caps = HashMap::new();

    let Some(items) = provider.get("models").and_then(Value::as_array) else {
        return (models, model_caps);
    };

    for item in items {
        if item
            .get("enabled")
            .and_then(Value::as_bool)
            .is_some_and(|enabled| !enabled)
        {
            continue;
        }
        let Some(model_id) = item
            .as_str()
            .map(str::to_string)
            .or_else(|| string_value(item, "id"))
            .or_else(|| string_value(item, "modelId"))
            .or_else(|| string_value(item, "name"))
        else {
            continue;
        };
        if model_id.trim().is_empty() {
            continue;
        }

        let caps = ModelCaps {
            vision: recursive_string_contains(item, "vision")
                || recursive_string_contains(item, "image"),
            tools: recursive_string_contains(item, "tool")
                || recursive_string_contains(item, "function"),
        };
        if caps.vision || caps.tools {
            model_caps.insert(model_id.clone(), caps);
        }
        models.push(model_id);
    }

    (unique_strings(models), model_caps)
}

#[derive(Debug, Clone)]
pub(super) struct CherryModelInfo {
    pub(super) model_id: String,
    pub(super) vision: bool,
    pub(super) tools: bool,
}

pub(super) fn load_cherry_models(conn: &Connection) -> HashMap<String, Vec<CherryModelInfo>> {
    let mut map: HashMap<String, Vec<CherryModelInfo>> = HashMap::new();
    if table_exists(conn, "user_model").ok() != Some(true) {
        return map;
    }
    let Ok(mut stmt) = conn.prepare(
        r#"SELECT "providerId", "modelId", "capabilities", "inputModalities",
                  "endpointTypes", "supportsStreaming", "isEnabled", "isHidden"
           FROM user_model
           ORDER BY "order_key", "modelId""#,
    ) else {
        return map;
    };
    let Ok(rows) = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, i64>(5).unwrap_or(1),
            row.get::<_, i64>(6).unwrap_or(1),
            row.get::<_, i64>(7).unwrap_or(0),
        ))
    }) else {
        return map;
    };

    for row in rows.flatten() {
        let (
            provider_id,
            model_id,
            capabilities_raw,
            input_modalities_raw,
            endpoint_types_raw,
            _supports_streaming,
            is_enabled,
            is_hidden,
        ) = row;
        if is_enabled == 0 || is_hidden != 0 || model_id.trim().is_empty() {
            continue;
        }
        let capabilities = parse_json_optional(capabilities_raw.as_deref());
        let input_modalities = parse_json_optional(input_modalities_raw.as_deref());
        let endpoint_types = parse_json_optional(endpoint_types_raw.as_deref());
        let vision = recursive_string_contains(&capabilities, "vision")
            || recursive_string_contains(&capabilities, "image")
            || recursive_string_contains(&input_modalities, "vision")
            || recursive_string_contains(&input_modalities, "image");
        let tools = recursive_string_contains(&capabilities, "tool")
            || recursive_string_contains(&capabilities, "function")
            || recursive_string_contains(&endpoint_types, "tool");
        map.entry(provider_id).or_default().push(CherryModelInfo {
            model_id,
            vision,
            tools,
        });
    }
    map
}

