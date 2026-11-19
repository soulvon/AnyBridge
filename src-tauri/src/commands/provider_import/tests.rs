use super::*;
use serde_json::json;
use std::path::Path;

#[test]
fn parses_cherry_local_storage_leveldb_log() {
    let value = cherry_persist_test_value();
    let mut batch = Vec::new();
    batch.extend_from_slice(&1u64.to_le_bytes());
    batch.extend_from_slice(&1u32.to_le_bytes());
    batch.push(1);
    let key = b"_file://\0\x01persist:cherry-studio";
    push_varint(&mut batch, key.len());
    batch.extend_from_slice(key);
    push_varint(&mut batch, value.len());
    batch.extend_from_slice(&value);

    let log = encode_leveldb_log(&batch);
    let roots = cherry_persist_roots_from_leveldb_log(&log);
    assert_eq!(roots.len(), 1);

    let mut candidates = Vec::new();
    scan_cherry_persisted_root(Path::new("000123.log"), &roots[0], &mut candidates);

    // v0.5.7 起支持导入 Gemini 供应商，测试数据里的两个供应商都应被解析
    assert_eq!(candidates.len(), 2);
    let candidate = &candidates[0];
    assert_eq!(candidate.name, "Custom OpenAI");
    assert_eq!(candidate.api_format, ApiFormat::Openai);
    assert_eq!(candidate.api_host, "https://api.example.com");
    assert_eq!(candidate.api_path.as_deref(), Some("/v1/responses"));
    assert_eq!(candidate.models, vec!["gpt-test"]);
    assert!(candidate.capabilities.vision);
    assert!(candidate.capabilities.tools);
    assert!(candidate
        .warnings
        .iter()
        .any(|warning| warning.contains("未启用")));

    let gemini = &candidates[1];
    assert_eq!(gemini.name, "Gemini");
    assert_eq!(gemini.api_format, ApiFormat::Gemini);
    assert_eq!(gemini.api_host, "https://generativelanguage.googleapis.com");
    assert_eq!(gemini.api_path.as_deref(), Some("/v1beta"));
    assert_eq!(gemini.models, vec!["gemini-test"]);
}

#[test]
fn parses_cherry_local_storage_leveldb_table() {
    let key = b"_file://\0\x01persist:cherry-studio";
    let value = cherry_persist_test_value();
    let table = encode_leveldb_table(key, &value, true);

    let roots = cherry_persist_roots_from_leveldb_table(&table);
    assert_eq!(roots.len(), 1);

    let mut candidates = Vec::new();
    scan_cherry_persisted_root(Path::new("000123.ldb"), &roots[0], &mut candidates);
    assert_eq!(candidates.len(), 2);
    assert_eq!(candidates[0].name, "Custom OpenAI");
    assert_eq!(candidates[0].api_path.as_deref(), Some("/v1/responses"));
    assert_eq!(candidates[1].name, "Gemini");
    assert_eq!(candidates[1].api_format, ApiFormat::Gemini);
}

fn cherry_persist_test_value() -> Vec<u8> {
    let llm = json!({
        "providers": [
            {
                "id": "custom-openai",
                "name": "Custom OpenAI",
                "type": "openai-response",
                "apiKey": "sk-test",
                "apiHost": "https://api.example.com",
                "models": [
                    { "id": "gpt-test", "capabilities": ["vision", "tools"] },
                    { "id": "disabled-test", "enabled": false }
                ],
                "enabled": false
            },
            {
                "id": "gemini",
                "name": "Gemini",
                "type": "gemini",
                "apiKey": "AIza-test",
                "apiHost": "https://generativelanguage.googleapis.com",
                "models": [{ "id": "gemini-test" }]
            }
        ]
    });
    let root = json!({
        "llm": llm.to_string(),
        "_persist": "{\"version\":207,\"rehydrated\":true}"
    });

    let mut value = vec![0xad, 0x94, 0x1a, 0x00];
    for unit in root.to_string().encode_utf16() {
        value.extend_from_slice(&unit.to_le_bytes());
    }
    value
}

fn push_varint(out: &mut Vec<u8>, mut value: usize) {
    while value >= 0x80 {
        out.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn encode_leveldb_log(logical_record: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut offset = 0;
    let mut first = true;

    while offset < logical_record.len() {
        let block_offset = out.len() % LEVELDB_LOG_BLOCK_SIZE;
        if LEVELDB_LOG_BLOCK_SIZE - block_offset <= LEVELDB_LOG_HEADER_SIZE {
            out.resize(out.len() + LEVELDB_LOG_BLOCK_SIZE - block_offset, 0);
        }

        let block_offset = out.len() % LEVELDB_LOG_BLOCK_SIZE;
        let available = LEVELDB_LOG_BLOCK_SIZE - block_offset - LEVELDB_LOG_HEADER_SIZE;
        let chunk_len = available.min(logical_record.len() - offset);
        let last = offset + chunk_len >= logical_record.len();
        let record_type = match (first, last) {
            (true, true) => 1,
            (true, false) => 2,
            (false, true) => 4,
            (false, false) => 3,
        };

        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&(chunk_len as u16).to_le_bytes());
        out.push(record_type);
        out.extend_from_slice(&logical_record[offset..offset + chunk_len]);

        offset += chunk_len;
        first = false;
    }

    out
}

fn encode_leveldb_table(key: &[u8], value: &[u8], snappy: bool) -> Vec<u8> {
    let data_block = encode_leveldb_block(&[(key.to_vec(), value.to_vec())]);
    let data_block = if snappy {
        snap::raw::Encoder::new()
            .compress_vec(&data_block)
            .expect("compress test block")
    } else {
        data_block
    };
    let data_offset = 0usize;
    let data_size = data_block.len();

    let mut out = Vec::new();
    out.extend_from_slice(&data_block);
    out.push(if snappy { 1 } else { 0 });
    out.extend_from_slice(&[0, 0, 0, 0]);

    let meta_offset = out.len();
    let meta_block = encode_leveldb_block(&[]);
    let meta_size = meta_block.len();
    out.extend_from_slice(&meta_block);
    out.push(0);
    out.extend_from_slice(&[0, 0, 0, 0]);

    let mut data_handle = Vec::new();
    push_varint(&mut data_handle, data_offset);
    push_varint(&mut data_handle, data_size);
    let index_offset = out.len();
    let index_block = encode_leveldb_block(&[(b"z".to_vec(), data_handle)]);
    let index_size = index_block.len();
    out.extend_from_slice(&index_block);
    out.push(0);
    out.extend_from_slice(&[0, 0, 0, 0]);

    let mut footer = Vec::new();
    push_varint(&mut footer, meta_offset);
    push_varint(&mut footer, meta_size);
    push_varint(&mut footer, index_offset);
    push_varint(&mut footer, index_size);
    footer.resize(LEVELDB_TABLE_FOOTER_SIZE - 8, 0);
    footer.extend_from_slice(&LEVELDB_TABLE_MAGIC.to_le_bytes());
    out.extend_from_slice(&footer);
    out
}

fn encode_leveldb_block(entries: &[(Vec<u8>, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut previous = Vec::new();
    let restart_offset = 0u32;
    for (key, value) in entries {
        let shared = previous
            .iter()
            .zip(key.iter())
            .take_while(|(a, b)| a == b)
            .count();
        push_varint(&mut out, shared);
        push_varint(&mut out, key.len() - shared);
        push_varint(&mut out, value.len());
        out.extend_from_slice(&key[shared..]);
        out.extend_from_slice(value);
        previous = key.clone();
    }
    out.extend_from_slice(&restart_offset.to_le_bytes());
    out.extend_from_slice(&1u32.to_le_bytes());
    out
}
