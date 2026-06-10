/// 从 vscdb 二进制内容中提取 email
/// 返回最后一个 lastLoginEmail（当前登录账号），而不是第一个（历史账号）
fn regex_extract_email(content: &str) -> Option<String> {
    let pattern = regex::Regex::new(r#""lastLoginEmail"\s*:\s*"([^"]+)""#).ok()?;
    
    // 找到所有匹配，返回最后一个
    let mut last_email = None;
    for caps in pattern.captures_iter(content) {
        if let Some(m) = caps.get(1) {
            let email = m.as_str().to_string();
            if !email.is_empty() {
                last_email = Some(email);
            }
        }
    }
    
    last_email
}

/// 从 vscdb 二进制内容中提取 apiServerUrl
/// 同样返回最后一个
fn regex_extract_api_server_url(content: &str) -> Option<String> {
    let pattern = regex::Regex::new(r#""apiServerUrl"\s*:\s*"([^"]+)""#).ok()?;
    
    let mut last_url = None;
    for caps in pattern.captures_iter(content) {
        if let Some(m) = caps.get(1) {
            let url = m.as_str().to_string();
            if !url.is_empty() {
                last_url = Some(url);
            }
        }
    }
    
    last_url
}
