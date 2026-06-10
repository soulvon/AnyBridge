/// 从 vscdb 中提取当前登录账号的 session 信息
/// 
/// 问题：vscdb 里有多个账号的历史数据，直接正则匹配会匹配到第一个（可能是旧账号）
/// 
/// 正确做法：
/// 1. 先定位 "codeium.windsurf" 或 "codeium.devin" 这个 key
/// 2. 提取它对应的 value（一个转义的 JSON 字符串）
/// 3. 在这个 JSON 字符串范围内提取 token 和 email
/// 
/// SQLite 存储格式示例：
/// "codeium.windsurf":"{\"lastLoginEmail\":\"user@example.com\",\"windsurf.pendingApiKeyMigration\":\"devin-session-token$...\"}"

fn extract_codeium_json(content: &str, target: &str) -> Option<String> {
    // 根据 target 确定 key 名称
    let key = if target == "devin" { "codeium.devin" } else { "codeium.windsurf" };
    
    // 匹配 "codeium.windsurf":"{ JSON 内容 }"
    // JSON 内容中的引号会被转义为 \"
    let pattern = format!(r#""{}"\s*:\s*"(\{{[^\}}]{{500,5000}}\}})""#, regex::escape(key));
    let re = regex::Regex::new(&pattern).ok()?;
    
    if let Some(caps) = re.captures(content) {
        if let Some(json_match) = caps.get(1) {
            // 提取到的是转义的 JSON 字符串，需要反转义
            let escaped_json = json_match.as_str();
            let unescaped = escaped_json.replace(r#"\""#, "\"").replace(r#"\\"#, "\\");
            return Some(unescaped);
        }
    }
    
    None
}

fn regex_extract_session_token_fixed(content: &str, target: &str) -> Option<String> {
    // 1. 尝试从 codeium JSON 中提取（当前账号）
    if let Some(json_str) = extract_codeium_json(content, target) {
        let token_fields = ["windsurf.pendingApiKeyMigration", "devin.pendingApiKeyMigration", "apiKey"];
        for field in token_fields {
            let pattern = format!(r#""{}"\s*:\s*"(devin-session-token\$[^"]+)""#, regex::escape(field));
            if let Ok(re) = regex::Regex::new(&pattern) {
                if let Some(caps) = re.captures(&json_str) {
                    if let Some(m) = caps.get(1) {
                        return Some(m.as_str().to_string());
                    }
                }
            }
        }
    }
    
    // 2. 回退：全局搜索（可能是旧账号）
    let patterns = [
        r#""windsurf\.pendingApiKeyMigration"\s*:\s*"(devin-session-token\$[^"]+)"#,
        r#""devin\.pendingApiKeyMigration"\s*:\s*"(devin-session-token\$[^"]+)"#,
        r#""apiKey"\s*:\s*"(devin-session-token\$[^"]+)"#,
    ];
    for pat in patterns {
        if let Ok(re) = regex::Regex::new(pat) {
            if let Some(caps) = re.captures(content) {
                if let Some(m) = caps.get(1) {
                    return Some(m.as_str().to_string());
                }
            }
        }
    }
    None
}

fn regex_extract_email_fixed(content: &str, target: &str) -> Option<String> {
    // 1. 尝试从 codeium JSON 中提取（当前账号）
    if let Some(json_str) = extract_codeium_json(content, target) {
        let pattern = regex::Regex::new(r#""lastLoginEmail"\s*:\s*"([^"]+)""#).ok()?;
        if let Some(caps) = pattern.captures(&json_str) {
            if let Some(m) = caps.get(1) {
                return Some(m.as_str().to_string());
            }
        }
    }
    
    // 2. 回退：全局搜索（可能是旧账号）
    let pattern = regex::Regex::new(r#""lastLoginEmail"\s*:\s*"([^"]+)""#).ok()?;
    if let Some(caps) = pattern.captures(content) {
        if let Some(m) = caps.get(1) {
            return Some(m.as_str().to_string());
        }
    }
    None
}
