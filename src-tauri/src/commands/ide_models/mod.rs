// ide_models.rs — IDE 模型清单：内置静态表 + 登录后从云端更新。
//
// 默认用内置静态表（覆盖主流模型，带干净显示名），无需登录。
// 用户在设置页「更新模型列表」时才登录 Windsurf 账户，从 GetUserStatus 拉取最新
// clientModelConfigs（含官方 label），合并/覆盖内置表后持久化到 ide-models.json。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;

// ─── 公共数据结构 ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdeModel {
    pub id: String,
    pub name: String,
    pub provider: String,
    #[serde(default)]
    pub common: bool,
    /// 模型槽位来源：account = 当前账号/API 实际返回；extended = 内置扩展槽位。
    #[serde(default = "default_model_origin")]
    pub origin: String,
    /// API 级模型 ID（如 claude-opus-4.5），旧模型用 MODEL_* 枚举当 id，
    /// 但实际调 API 需要用 api_id。新模型的 id 本身就是 API 级 ID，api_id 为 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_id: Option<String>,
}

fn default_model_origin() -> String {
    "extended".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdeAccountSummary {
    pub email: String,
    pub plan_name: String,
    pub teams_tier: String,
    pub daily_remaining: i32,
    pub weekly_remaining: i32,
    pub overage_balance_micros: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdeModelsResult {
    pub models: Vec<IdeModel>,
    pub source: String,
    #[serde(default)]
    pub captured_at: Option<u64>,
    #[serde(default)]
    pub account: Option<IdeAccountSummary>,
}

/// refresh_ide_models 命令的返回值
#[derive(Debug, Clone, Serialize)]
pub struct IdeAccountInfo {
    pub email: String,
    pub plan_name: String,
    pub teams_tier: String,
    pub daily_remaining: i32,
    pub weekly_remaining: i32,
    pub overage_balance_micros: i64,
    pub models: Vec<IdeModel>,
}

// ─── 缓存文件反序列化 ──────────────────────────────────────

#[derive(Debug, Deserialize)]
struct CapturedEntry {
    #[serde(rename = "modelUid")]
    model_uid: String,
    label: String,
    #[serde(rename = "apiId", default)]
    api_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CacheAccount {
    email: String,
    #[serde(rename = "planName")]
    plan_name: String,
    #[serde(rename = "teamsTier", default)]
    teams_tier: String,
    #[serde(rename = "dailyRemaining")]
    daily_remaining: i32,
    #[serde(rename = "weeklyRemaining")]
    weekly_remaining: i32,
    #[serde(rename = "overageBalanceMicros")]
    overage_balance_micros: i64,
}

#[derive(Debug, Deserialize)]
struct CacheFile {
    #[serde(default)]
    models: Vec<CapturedEntry>,
    #[serde(rename = "accountModelIds", default)]
    account_model_ids: Vec<String>,
    #[serde(default)]
    source: String,
    #[serde(rename = "capturedAt", default)]
    captured_at: Option<u64>,
    #[serde(default)]
    account: Option<CacheAccount>,
}

// ─── Session 读取 ──────────────────────────────────────────

struct IdeSession {
    #[allow(dead_code)]
    email: String,
    api_key: String,
    api_server_url: String,
}

fn read_ide_session(target: &str) -> Result<IdeSession, String> {
    // macOS: VSCode 系 IDE 的 globalStorage 在 ~/Library/Application Support/ 下
    // dirs::config_dir() 在 macOS 返回 ~/Library/Preferences（错误），需用 data_dir()
    #[cfg(target_os = "macos")]
    let mut db_path = dirs::data_dir().ok_or("无法定位配置目录")?;
    #[cfg(not(target_os = "macos"))]
    let mut db_path = dirs::config_dir().ok_or("无法定位配置目录")?;

    let ide_dir = match target {
        "devin" => "Devin",
        _ => "Windsurf",
    };
    db_path.push(ide_dir);
    db_path.push("User");
    db_path.push("globalStorage");
    db_path.push("state.vscdb");

    if !db_path.exists() {
        return Err(format!(
            "{} state.vscdb 不存在，请先启动 {}",
            ide_dir, ide_dir
        ));
    }

    // 与 windsurf-pool 相同的方案：直接读二进制文件 + 正则提取，
    // 绕过 SQLite WAL 锁问题（IDE 运行时数据库被锁定，rusqlite 无法读取）
    let buf = fs::read(&db_path).map_err(|e| format!("读取 vscdb 失败: {}", e))?;

    // 限制文件大小（超过 10MB 跳过，避免内存问题）
    if buf.len() > 10 * 1024 * 1024 {
        return Err("state.vscdb 文件过大（>10MB），无法读取".into());
    }

    // SQLite 二进制文件中，JSON 值以 UTF-8 存储，直接转字符串后正则提取
    let content = String::from_utf8_lossy(&buf);

    // 提取 codeium.windsurf 对应的 JSON value（包含 pendingApiKeyMigration 等字段）
    // SQLite 页面中 key-value 对的存储格式：key 和 value 相邻，value 是 JSON 字符串
    // 匹配 "windsurf.pendingApiKeyMigration" 后面紧跟的 session token
    let api_key = regex_extract_session_token(&content).ok_or(format!(
        "未在 {} state.vscdb 中找到 devin-session-token，{} 可能未登录",
        ide_dir, ide_dir
    ))?;

    // 提取 email
    let email = regex_extract_email(&content).unwrap_or_default();

    // 提取 apiServerUrl
    let api_server_url = regex_extract_api_server_url(&content)
        .unwrap_or_else(|| "https://server.self-serve.windsurf.com".to_string());

    if !api_key.starts_with("devin-session-token$") {
        return Err(format!(
            "session token 格式异常（期望 devin-session-token$ 前缀，实际: {}...）",
            &api_key[..api_key.len().min(30)]
        ));
    }

    Ok(IdeSession {
        email,
        api_key,
        api_server_url,
    })
}

/// 从 vscdb 二进制内容中提取 session token
/// 只接受 devin-session-token$ 前缀（唯一能成功调 GetUserStatus 的格式）
fn regex_extract_session_token(content: &str) -> Option<String> {
    let patterns = [
        r#""apiKey"\s*:\s*"(devin-session-token\$[^"]+)"#,
        r#""windsurf\.pendingApiKeyMigration"\s*:\s*"(devin-session-token\$[^"]+)"#,
        r#""idToken"\s*:\s*"(devin-session-token\$[^"]+)"#,
    ];
    for pat in patterns {
        let re = regex::Regex::new(pat).ok()?;
        let last = re
            .captures_iter(content)
            .filter_map(|caps| caps.get(1).map(|m| m.as_str().to_string()))
            .last();
        if let Some(token) = last {
            if !token.is_empty() {
                return Some(token);
            }
        }
    }
    None
}

/// 从 vscdb 二进制内容中提取 email
fn regex_extract_email(content: &str) -> Option<String> {
    let pattern = regex::Regex::new(r#""lastLoginEmail"\s*:\s*"([^"]+)""#).ok()?;
    pattern
        .captures_iter(content)
        .filter_map(|caps| caps.get(1).map(|m| m.as_str().to_string()))
        .last()
        .filter(|email| !email.is_empty())
}

/// 从 vscdb 二进制内容中提取 apiServerUrl
fn regex_extract_api_server_url(content: &str) -> Option<String> {
    let pattern = regex::Regex::new(r#""apiServerUrl"\s*:\s*"([^"]+)""#).ok()?;
    pattern
        .captures_iter(content)
        .filter_map(|caps| caps.get(1).map(|m| m.as_str().to_string()))
        .last()
        .filter(|url| !url.is_empty())
}

// ─── 调用 GetUserStatus API ────────────────────────────────

async fn fetch_ide_account_info(session: &IdeSession) -> Result<IdeAccountInfo, String> {
    let client = super::apply_system_proxy(reqwest::Client::builder())
        .timeout(std::time::Duration::from_secs(6))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!(
        "{}/exa.seat_management_pb.SeatManagementService/GetUserStatus",
        session.api_server_url.trim_end_matches('/')
    );

    let body = serde_json::json!({
        "metadata": {
            "apiKey": session.api_key,
            "ideName": "windsurf",
            "ideVersion": "0.0.0",
            "extensionName": "windsurf-next",
            "extensionVersion": "1.0.0",
            "locale": "en"
        }
    });

    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Connect-Protocol-Version", "1")
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求 GetUserStatus 失败: {}", e))?;

    let status = resp.status();
    if status.as_u16() == 401 {
        return Err("session token 已失效 (401)，请在 Windsurf 中重新登录".into());
    }
    if status.as_u16() == 403 {
        return Err("账号无权限或被封禁 (403)".into());
    }
    if !status.is_success() {
        return Err(format!("GetUserStatus 返回异常: HTTP {}", status));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析 GetUserStatus 响应失败: {}", e))?;

    parse_account_info(data)
}

// ─── 解析 + 合并模型列表 ──────────────────────────────────

fn should_skip_model(model_id: &str) -> bool {
    model_id.starts_with("MODEL_CODEMAP_")
        || model_id.starts_with("MODEL_COGNITION_")
        || model_id.starts_with("MODEL_LLAMA_FT_")
        || model_id.ends_with("_BYOK")
        || model_id.ends_with("_THINKING_BYOK")
        || model_id.ends_with("_REDIRECT")
        || model_id.is_empty()
}

fn parse_account_info(data: serde_json::Value) -> Result<IdeAccountInfo, String> {
    let builtin = builtin_models();

    let email = data
        .pointer("/userStatus/email")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let plan_name = data
        .pointer("/planInfo/planName")
        .or_else(|| data.pointer("/userStatus/planStatus/planInfo/planName"))
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown")
        .to_string();
    let teams_tier = data
        .pointer("/userStatus/teamsTier")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let daily_remaining = data
        .pointer("/userStatus/planStatus/dailyQuotaRemainingPercent")
        .and_then(|v| v.as_i64())
        .unwrap_or(-1) as i32;
    let weekly_remaining = data
        .pointer("/userStatus/planStatus/weeklyQuotaRemainingPercent")
        .and_then(|v| v.as_i64())
        .unwrap_or(-1) as i32;
    let overage_balance_micros = data
        .pointer("/userStatus/planStatus/overageBalanceMicros")
        .and_then(|v| {
            v.as_str()
                .and_then(|s| s.parse::<i64>().ok())
                .or(v.as_i64())
        })
        .unwrap_or(0);

    // 数据源 1：cascadeAllowedModelsConfig 权限全集（很多 model 为空，含 BYOK / 基础设施模型）
    let allowed: HashSet<String> = data
        .pointer("/planInfo/cascadeAllowedModelsConfig")
        .or_else(|| data.pointer("/userStatus/planStatus/planInfo/cascadeAllowedModelsConfig"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| e.pointer("/modelOrAlias/model").and_then(|m| m.as_str()))
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();

    // 数据源 2：clientModelConfigs —— Windsurf 客户端实际渲染到下拉框的模型，带官方 label。
    // 这些是用户真正能选的热门模型，必须并入集合（且不走 should_skip 过滤）。
    let client_configs = data
        .pointer("/userStatus/cascadeModelConfigData/clientModelConfigs")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut label_map: HashMap<String, String> = HashMap::new();
    let mut client_ids: Vec<String> = Vec::new();
    for e in &client_configs {
        let uid = match e.get("modelUid").and_then(|v| v.as_str()) {
            Some(u) if !u.is_empty() => u.to_string(),
            _ => continue,
        };
        if let Some(label) = e.get("label").and_then(|v| v.as_str()) {
            if !label.is_empty() {
                label_map.insert(uid.clone(), label.to_string());
            }
        }
        client_ids.push(uid);
    }

    // 合并：clientModelConfigs（保留顺序、不过滤）打底，再追加 allowed 中通过过滤的补充模型。
    let mut ordered_ids: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for id in &client_ids {
        if seen.insert(id.clone()) {
            ordered_ids.push(id.clone());
        }
    }
    for id in &allowed {
        if should_skip_model(id) {
            continue;
        }
        if seen.insert(id.clone()) {
            ordered_ids.push(id.clone());
        }
    }

    // 用 builtin 兜底 label / provider / common / api_id
    let models: Vec<IdeModel> = ordered_ids
        .iter()
        .map(|id| {
            let builtin_match = builtin.iter().find(|m| m.id == *id);
            let name = label_map
                .get(id)
                .cloned()
                .or_else(|| builtin_match.map(|m| m.name.clone()))
                .unwrap_or_else(|| id.clone());
            let provider = builtin_match
                .map(|m| m.provider.clone())
                .unwrap_or_else(|| "other".to_string());
            let common = builtin_match.map(|m| m.common).unwrap_or(false);
            let api_id = builtin_match.and_then(|m| m.api_id.clone());
            IdeModel {
                id: id.clone(),
                name,
                provider,
                common,
                origin: "account".to_string(),
                api_id,
            }
        })
        .collect();

    Ok(IdeAccountInfo {
        email,
        plan_name,
        teams_tier,
        daily_remaining,
        weekly_remaining,
        overage_balance_micros,
        models,
    })
}

// ─── 缓存读写 ──────────────────────────────────────────────

/// 合并只增不减：sidecar 拦截 protobuf 抓到的完整列表（60+ 条）是权威源，
/// JSON API 只能拿当前账号的精简列表。直接覆盖会冲掉 sidecar 的数据，
/// 所以这里读旧缓存 → 以 modelUid 去重合并 → 旧条目一律保留，只新增 API 带来的新模型。
/// 账号信息（额度 / plan）始终用本次 API 结果刷新。
fn save_ide_models_cache(info: &IdeAccountInfo) -> Result<Vec<IdeModel>, String> {
    let dir = super::config::config_dir_path();
    let path = dir.join("ide-models.json");

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    // 读旧缓存的 models（保留顺序），按 modelUid 去重
    // 元组: (modelUid, label, api_id)
    let mut ordered: Vec<(String, String, Option<String>)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    // 旧 accountModelIds：sidecar 抓取的下拉清单比 JSON API 更完整，API 刷新时只增不减。
    let mut prev_account_model_ids: HashSet<String> = HashSet::new();
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(old) = serde_json::from_str::<CacheFile>(&raw) {
            prev_account_model_ids = old.account_model_ids.into_iter().collect();
            for e in old.models {
                if e.label.starts_with("http") {
                    continue; // 跳过拦截噪声（apiServerUrl 被误当 label）
                }
                if seen.insert(e.model_uid.clone()) {
                    ordered.push((e.model_uid, e.label, e.api_id));
                }
            }
        }
    }

    // 合并本次 API 模型：新 modelUid 追加；已存在的用 API 的 label 覆盖（模型改名时更新显示名）
    for m in &info.models {
        if seen.insert(m.id.clone()) {
            ordered.push((m.id.clone(), m.name.clone(), m.api_id.clone()));
        } else if let Some(slot) = ordered.iter_mut().find(|(id, _, _)| id == &m.id) {
            slot.1 = m.name.clone();
            // api_id 优先用 builtin / API 带来的值
            if m.api_id.is_some() {
                slot.2 = m.api_id.clone();
            }
        }
    }

    // 始终将内置静态表合并进去，确保新装用户也能看到完整模型列表。
    // 不覆盖已有条目（缓存 / API 的 label 优先级更高，因为它们可能包含官方最新显示名）。
    let builtin = builtin_models();
    for m in &builtin {
        if seen.insert(m.id.clone()) {
            ordered.push((m.id.clone(), m.name.clone(), m.api_id.clone()));
        } else if let Some(slot) = ordered.iter_mut().find(|(id, _, _)| id == &m.id) {
            // builtin 的 api_id 优先级最高（硬编码的权威映射）
            if m.api_id.is_some() {
                slot.2 = m.api_id.clone();
            }
        }
    }

    // 「当前账号」= API 返回 ∪ 缓存中仍存在的旧账号槽位（通常来自 sidecar 下拉抓取）。
    // JSON GetUserStatus 不含 Inkling/Nemotron 等新形态 ID，直接覆盖会让 UI 与 Windsurf 下拉不一致。
    let mut account_model_ids: HashSet<String> =
        info.models.iter().map(|m| m.id.clone()).collect();
    for id in prev_account_model_ids {
        if seen.contains(&id) {
            account_model_ids.insert(id);
        }
    }

    let cache = serde_json::json!({
        "capturedAt": now_ms,
        "source": "api",
        "accountModelIds": account_model_ids.iter().cloned().collect::<Vec<_>>(),
        "account": {
            "email": info.email,
            "planName": info.plan_name,
            "teamsTier": info.teams_tier,
            "dailyRemaining": info.daily_remaining,
            "weeklyRemaining": info.weekly_remaining,
            "overageBalanceMicros": info.overage_balance_micros,
        },
        "models": ordered.iter().map(|(id, label, api_id)| {
            let mut obj = serde_json::json!({
                "modelUid": id,
                "label": label,
            });
            if let Some(aid) = api_id {
                obj["apiId"] = serde_json::Value::String(aid.clone());
            }
            obj
        }).collect::<Vec<_>>(),
    });

    let bytes = serde_json::to_string_pretty(&cache)
        .map_err(|e| format!("序列化缓存失败: {}", e))?
        .into_bytes();

    super::write_atomic(&path, &bytes)?;

    // 返回合并后的完整列表，供 UI 展示（不止本次 API 的精简列表）
    let builtin = builtin_models();
    let merged: Vec<IdeModel> = ordered
        .into_iter()
        .map(|(id, label, api_id)| {
            let builtin_match = builtin.iter().find(|m| m.id == id);
            let provider = builtin_match
                .map(|m| m.provider.clone())
                .unwrap_or_else(|| "other".to_string());
            let common = builtin_match.map(|m| m.common).unwrap_or(false);
            // api_id 优先用 builtin 的硬编码值，其次用缓存/API 带来的值
            let final_api_id = builtin_match.and_then(|m| m.api_id.clone()).or(api_id);
            let origin = if account_model_ids.contains(&id) {
                "account"
            } else {
                "extended"
            }
            .to_string();
            IdeModel {
                id,
                name: label,
                provider,
                common,
                origin,
                api_id: final_api_id,
            }
        })
        .collect();
    Ok(merged)
}

// ─── 内置静态表 ──────────────────────────────────────────────

mod catalog_primary;
mod catalog_extended;

pub fn builtin_models() -> Vec<IdeModel> {
    let mut out = catalog_primary::primary_models();
    out.extend(catalog_extended::extended_models());
    out
}

/// 同时返回缓存中的账号信息（如有）。
#[tauri::command]
pub async fn list_ide_models() -> Result<IdeModelsResult, String> {
    tauri::async_runtime::spawn_blocking(list_ide_models_sync)
        .await
        .map_err(|e| format!("读取 IDE 模型列表任务失败: {e}"))?
}

fn list_ide_models_sync() -> Result<IdeModelsResult, String> {
    let builtin = builtin_models();
    let path = super::config::config_dir_path().join("ide-models.json");

    // 先加载缓存
    // 元组: (modelUid, label, api_id)
    let mut ordered: Vec<(String, String, Option<String>)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut source = "builtin".to_string();
    let mut captured_at: Option<u64> = None;
    let mut account: Option<IdeAccountSummary> = None;
    let mut account_model_ids: HashSet<String> = HashSet::new();

    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(parsed) = serde_json::from_str::<CacheFile>(&raw) {
            source = if parsed.source.is_empty() {
                "captured".into()
            } else {
                parsed.source
            };
            captured_at = parsed.captured_at;
            account_model_ids = parsed.account_model_ids.into_iter().collect();
            account = parsed.account.map(|a| IdeAccountSummary {
                email: a.email,
                plan_name: a.plan_name,
                teams_tier: a.teams_tier,
                daily_remaining: a.daily_remaining,
                weekly_remaining: a.weekly_remaining,
                overage_balance_micros: a.overage_balance_micros,
            });
            for e in parsed.models {
                if e.label.starts_with("http") {
                    continue;
                }
                if seen.insert(e.model_uid.clone()) {
                    ordered.push((e.model_uid, e.label, e.api_id));
                }
            }
        }
    }

    // 合并内置静态表：缓存未覆盖的模型一律补入，确保新装也有 100+ 模型
    for m in &builtin {
        if seen.insert(m.id.clone()) {
            ordered.push((m.id.clone(), m.name.clone(), m.api_id.clone()));
        } else if let Some(slot) = ordered.iter_mut().find(|(id, _, _)| id == &m.id) {
            // builtin 的 api_id 优先级最高
            if m.api_id.is_some() {
                slot.2 = m.api_id.clone();
            }
        }
    }

    let models: Vec<IdeModel> = ordered
        .into_iter()
        .map(|(id, label, api_id)| {
            let builtin_match = builtin.iter().find(|m| m.id == id);
            let provider = builtin_match
                .map(|m| m.provider.clone())
                .unwrap_or_else(|| "other".to_string());
            let common = builtin_match.map(|m| m.common).unwrap_or(false);
            let final_api_id = builtin_match.and_then(|m| m.api_id.clone()).or(api_id);
            let origin = if account_model_ids.contains(&id) {
                "account"
            } else {
                "extended"
            }
            .to_string();
            IdeModel {
                id,
                name: label,
                provider,
                common,
                origin,
                api_id: final_api_id,
            }
        })
        .collect();

    Ok(IdeModelsResult {
        models,
        source,
        captured_at,
        account,
    })
}

/// 从 IDE 本地 session 拉取最新模型列表 + 账号信息，缓存后返回。
/// target: "windsurf"、"devin" 或 "auto"（自动检测），决定从哪个 vscdb 读取 session。
#[tauri::command]
pub async fn refresh_ide_models(target: Option<String>) -> Result<IdeAccountInfo, String> {
    let t = match target.as_deref() {
        Some("auto") | None => crate::commands::system::detect_target_ide(),
        Some(s) => s.to_string(),
    };
    let session = read_ide_session(&t)?;
    let info = fetch_ide_account_info(&session).await?;
    save_ide_models_cache(&info)?;
    Ok(info)
}

