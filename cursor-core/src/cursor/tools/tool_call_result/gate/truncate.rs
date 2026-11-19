pub(super) fn truncate_text(tool_name: &str, content: &str, limit: usize) -> String {
    if content.len() <= limit {
        return content.to_string();
    }
    let original = content.len();
    let mut shown = limit;
    let mut previous = None;
    loop {
        let notice = format!(
            "\n\n[truncated: {tool_name} result exceeded {limit} bytes; showing {shown} of {original} bytes]"
        );
        if notice.len() >= limit {
            // The notice alone would blow the budget; keep a plain prefix so the
            // result never costs more than `limit` bytes.
            return utf8_prefix(content, limit).to_string();
        }
        let kept = utf8_prefix(content, limit - notice.len());
        // `notice.len()` grows with the digit count of `shown`, so `kept.len()`
        // can alternate between two values across a power-of-ten boundary.
        if kept.len() == shown || previous == Some(kept.len()) {
            return truncated_prefix_with_notice(tool_name, content, limit, original, kept.len());
        }
        previous = Some(shown);
        shown = kept.len();
    }
}

fn truncated_prefix_with_notice(
    tool_name: &str,
    content: &str,
    limit: usize,
    original: usize,
    initial_cap: usize,
) -> String {
    let mut cap = initial_cap;
    loop {
        let kept = utf8_prefix(content, cap).trim_end_matches('\n');
        let notice = format!(
            "\n\n[truncated: {tool_name} result exceeded {limit} bytes; showing {} of {original} bytes]",
            kept.len()
        );
        if notice.len() >= limit {
            return utf8_prefix(content, limit).to_string();
        }
        let available = limit - notice.len();
        if kept.len() <= available {
            return format!("{kept}{notice}");
        }
        cap = available;
    }
}

pub(super) fn truncate_edges(tool_name: &str, content: &str, limit: usize) -> String {
    if content.len() <= limit {
        return content.to_string();
    }
    let original = content.len();
    let mut shown = limit;
    loop {
        let notice = format!(
            "\n\n[truncated: {tool_name} result exceeded {limit} bytes; omitted middle; showing {shown} of {original} bytes]\n\n"
        );
        let available = limit.saturating_sub(notice.len());
        let head = utf8_prefix(content, available / 2);
        let tail = utf8_suffix(content, available.saturating_sub(head.len()));
        let next_shown = head.len().saturating_add(tail.len());
        if next_shown == shown {
            return format!("{head}{notice}{tail}");
        }
        shown = next_shown;
    }
}

pub(super) fn truncation_notice(tool_name: &str, limit: usize, shown: usize, original: usize) -> String {
    format!(
        "[truncated: {tool_name} result exceeded {limit} bytes; showing {shown} of {original} bytes]"
    )
}

pub(super) fn utf8_prefix(value: &str, limit: usize) -> &str {
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
