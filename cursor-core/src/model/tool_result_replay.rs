//! Restores provider-visible Tool results from persisted data.
use serde_json::Value;

const KIB: usize = 1024;

pub(crate) fn limit_tool_result_text(name: &str, content: &str) -> String {
    let Some(limit) = replay_limit(name) else {
        return content.to_string();
    };
    let content = match name.trim() {
        "GenerateImage" => compact_generate_image(content),
        "Shell" => compact_shell(content),
        "PatchEdit" | "PatchEditLines" | "PatchEditSpan" | "StrReplace" | "Edit" | "Write" => {
            compact_edit(name, content)
        }
        _ => None,
    }
    .unwrap_or_else(|| content.to_string());
    truncate_replay_text(name, &content, limit)
}

fn replay_limit(name: &str) -> Option<usize> {
    match name.trim() {
        "GenerateImage" | "WebSearch" => Some(16 * KIB),
        "Read" => Some(64 * KIB),
        "Shell" => Some(128 * KIB),
        "Grep" | "Glob" => Some(32 * KIB),
        "PatchEdit" | "PatchEditLines" | "PatchEditSpan" | "StrReplace" => Some(4 * KIB),
        "Edit" | "EditNotebook" | "Write" | "WebFetch" => Some(32 * KIB),
        "CallMcpTool" | "FetchMcpResource" | "ListMcpResources" | "GetMcpTools"
        | "SembleSearch" | "SembleFindRelated" => Some(32 * KIB),
        _ => None,
    }
}

fn truncate_replay_text(name: &str, content: &str, limit: usize) -> String {
    if content.len() <= limit {
        return content.to_string();
    }
    let original = content.len();
    let mut shown = limit;
    loop {
        let notice = format!(
            "\n\n[truncated: {name} result exceeded {limit} bytes; showing {shown} of {original} bytes]"
        );
        let available = limit.saturating_sub(notice.len());
        let kept = utf8_prefix(content, available);
        if kept.len() == shown {
            return format!("{}{notice}", kept.trim_end_matches('\n'));
        }
        shown = kept.len();
    }
}

fn compact_generate_image(content: &str) -> Option<String> {
    let mut value = serde_json::from_str::<Value>(content.trim()).ok()?;
    if !replace_image_data(&mut value) {
        return None;
    }
    serde_json::to_string(&value).ok()
}

fn replace_image_data(value: &mut Value) -> bool {
    match value {
        Value::Object(object) => {
            let mut changed = false;
            for (key, child) in object.iter_mut() {
                if matches!(key.as_str(), "image_data" | "imageData") {
                    if let Value::String(data) = child {
                        if data.starts_with("[base64 image data omitted from replay; bytes=") {
                            continue;
                        }
                        *child = Value::String(format!(
                            "[base64 image data omitted from replay; bytes={}]",
                            data.trim().len()
                        ));
                        changed = true;
                        continue;
                    }
                }
                changed |= replace_image_data(child);
            }
            changed
        }
        Value::Array(items) => items.iter_mut().any(replace_image_data),
        _ => false,
    }
}

fn compact_shell(content: &str) -> Option<String> {
    let mut value = serde_json::from_str::<Value>(content.trim()).ok()?;
    if !compact_shell_fields(&mut value) {
        return None;
    }
    serde_json::to_string(&value).ok()
}

fn compact_shell_fields(value: &mut Value) -> bool {
    match value {
        Value::Object(object) => {
            let mut changed = false;
            for (key, child) in object.iter_mut() {
                if let Value::String(text) = child {
                    let limit = match key.as_str() {
                        "stdout" | "stderr" => Some(16 * KIB),
                        "interleaved_output" | "interleavedOutput" => Some(32 * KIB),
                        _ => None,
                    };
                    if let Some(limit) = limit {
                        let next = truncate_middle(&format!("Shell {key}"), text, limit);
                        if next != *text {
                            *text = next;
                            changed = true;
                        }
                        continue;
                    }
                }
                changed |= compact_shell_fields(child);
            }
            changed
        }
        Value::Array(items) => items.iter_mut().any(compact_shell_fields),
        _ => false,
    }
}

fn compact_edit(name: &str, content: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(content.trim()).ok()?;
    let success = value.get("success")?.as_object()?;
    let diff = success
        .get("diff_string")
        .or_else(|| success.get("diffString"))
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(|text| truncate_replay_text(name, text, edit_limit(name)));
    if let Some(diff) = diff {
        return Some(serde_json::json!({"success": {"diff_string": diff}}).to_string());
    }
    let after = success
        .get("after_full_file_content")
        .or_else(|| success.get("afterFullFileContent"))
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(|text| truncate_replay_text(name, text, edit_limit(name)));
    after
        .map(|after| serde_json::json!({"success": {"after_full_file_content": after}}).to_string())
}

fn edit_limit(name: &str) -> usize {
    match name.trim() {
        "PatchEdit" | "PatchEditLines" | "PatchEditSpan" | "StrReplace" => 4 * KIB,
        _ => 32 * KIB,
    }
}

fn truncate_middle(name: &str, content: &str, limit: usize) -> String {
    if content.len() <= limit {
        return content.to_string();
    }
    let original = content.len();
    let mut shown = limit;
    loop {
        let notice = format!(
            "\n\n[truncated: {name} result exceeded {limit} bytes; omitted middle; showing {shown} of {original} bytes]\n\n"
        );
        let available = limit.saturating_sub(notice.len());
        let head = utf8_prefix(content, available / 2);
        let tail = utf8_suffix(content, available.saturating_sub(head.len()));
        let next_shown = head.len() + tail.len();
        let next_notice = format!(
            "\n\n[truncated: {name} result exceeded {limit} bytes; omitted middle; showing {next_shown} of {original} bytes]\n\n"
        );
        let output = format!("{head}{next_notice}{tail}");
        if output.len() <= limit || next_notice == notice {
            return output;
        }
        shown = next_shown;
    }
}

fn utf8_prefix(value: &str, limit: usize) -> &str {
    let mut end = limit.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn utf8_suffix(value: &str, limit: usize) -> &str {
    let mut start = value.len().saturating_sub(limit);
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    &value[start..]
}
