use super::config::{
    ApiFormat, ModelCaps, Provider, ProviderCapabilities, ProviderStore,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProviderCandidate {
    pub id: String,
    pub source: String,
    pub source_id: String,
    pub source_path: String,
    pub name: String,
    pub api_host: String,
    pub api_key: String,
    pub api_path: Option<String>,
    pub default_model: String,
    pub api_format: ApiFormat,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub capabilities: ProviderCapabilities,
    #[serde(rename = "modelCaps", default)]
    pub model_caps: HashMap<String, ModelCaps>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportScanResult {
    pub candidates: Vec<ImportProviderCandidate>,
    pub notices: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProvidersResult {
    pub imported: usize,
    pub skipped: usize,
    pub store: ProviderStore,
    pub messages: Vec<String>,
}

#[derive(Clone)]
pub(super) struct ProviderImportScanSession {
    id: String,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default, Clone)]
pub struct ProviderImportScanState {
    active: Arc<Mutex<Option<ProviderImportScanSession>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportScanProgressEvent {
    pub scan_id: String,
    pub phase: String,
    pub source_key: String,
    pub source_label: String,
    pub status: String,
    pub message: String,
    pub completed: usize,
    pub total: usize,
    pub found: usize,
    pub candidates: Vec<ImportProviderCandidate>,
    pub notices: Vec<String>,
    pub done: bool,
    pub cancelled: bool,
}

pub(super) const ALL_IMPORT_SOURCE_KEYS: [&str; 3] = ["cc-switch", "cockpit-tools", "cherry-studio"];

#[tauri::command]
pub fn scan_importable_providers(sources: Option<Vec<String>>) -> Result<ImportScanResult, String> {
    let mut candidates = Vec::new();
    let mut notices = Vec::new();
    let selected_sources = selected_import_sources(sources);

    if selected_sources.contains("cc-switch") {
        scan_cc_switch(&mut candidates, &mut notices);
    }
    if selected_sources.contains("cockpit-tools") {
        scan_cockpit_tools(&mut candidates, &mut notices);
    }
    if selected_sources.contains("cherry-studio") {
        scan_cherry_studio(&mut candidates, &mut notices);
    }

    let mut seen = HashSet::new();
    candidates.retain(|c| seen.insert(candidate_signature(c)));
    candidates.sort_by(|a, b| {
        a.source
            .cmp(&b.source)
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.api_host.cmp(&b.api_host))
    });

    Ok(ImportScanResult {
        candidates,
        notices,
    })
}

#[tauri::command]
pub async fn start_provider_import_scan(
    app: AppHandle,
    state: State<'_, ProviderImportScanState>,
    sources: Option<Vec<String>>,
) -> Result<String, String> {
    let selected_sources = selected_import_source_keys(sources);
    if selected_sources.is_empty() {
        return Err("没有可扫描的来源".to_string());
    }

    let scan_id = new_provider_import_scan_id();
    let session = ProviderImportScanSession {
        id: scan_id.clone(),
        cancelled: Arc::new(AtomicBool::new(false)),
    };

    {
        let mut active = state
            .active
            .lock()
            .map_err(|_| "扫描状态锁定失败".to_string())?;
        if let Some(previous) = active.take() {
            previous.cancelled.store(true, Ordering::Relaxed);
        }
        *active = Some(session.clone());
    }

    let scan_state = state.inner().clone();
    let app_handle = app.clone();
    let scan_id_for_task = scan_id.clone();
    tauri::async_runtime::spawn(async move {
        run_provider_import_scan_task(app_handle, scan_state, session, selected_sources).await;
    });

    Ok(scan_id_for_task)
}

#[tauri::command]
pub fn cancel_provider_import_scan(
    state: State<'_, ProviderImportScanState>,
) -> Result<(), String> {
    let active = state
        .active
        .lock()
        .map_err(|_| "扫描状态锁定失败".to_string())?;
    if let Some(session) = active.as_ref() {
        session.cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
}

pub(super) async fn run_provider_import_scan_task(
    app: AppHandle,
    state: ProviderImportScanState,
    session: ProviderImportScanSession,
    sources: Vec<String>,
) {
    let total = sources.len();
    let mut all_candidates = Vec::new();
    let mut all_notices = Vec::new();

    emit_provider_import_scan_event(
        &app,
        ImportScanProgressEvent {
            scan_id: session.id.clone(),
            phase: "started".to_string(),
            source_key: String::new(),
            source_label: String::new(),
            status: "scanning".to_string(),
            message: "开始扫描本机配置".to_string(),
            completed: 0,
            total,
            found: 0,
            candidates: Vec::new(),
            notices: Vec::new(),
            done: false,
            cancelled: false,
        },
    );

    for (idx, source_key) in sources.into_iter().enumerate() {
        if session.cancelled.load(Ordering::Relaxed) {
            emit_provider_import_cancelled(&app, &session.id, idx, total);
            clear_provider_import_scan_session(&state, &session.id);
            return;
        }

        let source_label = provider_import_source_label(&source_key).to_string();
        emit_provider_import_scan_event(
            &app,
            ImportScanProgressEvent {
                scan_id: session.id.clone(),
                phase: "source-start".to_string(),
                source_key: source_key.clone(),
                source_label: source_label.clone(),
                status: "scanning".to_string(),
                message: format!("正在扫描 {}", source_label),
                completed: idx,
                total,
                found: 0,
                candidates: Vec::new(),
                notices: Vec::new(),
                done: false,
                cancelled: false,
            },
        );

        let source_for_worker = source_key.clone();
        let scan_result =
            tokio::task::spawn_blocking(move || scan_provider_import_source(&source_for_worker))
                .await;
        let (source_candidates, source_notices) = match scan_result {
            Ok(result) => result,
            Err(e) => (
                Vec::new(),
                vec![format!("{}：扫描任务异常：{}", source_label, e)],
            ),
        };

        if session.cancelled.load(Ordering::Relaxed) {
            emit_provider_import_cancelled(&app, &session.id, idx, total);
            clear_provider_import_scan_session(&state, &session.id);
            return;
        }

        let found = source_candidates.len();
        all_candidates.extend(source_candidates.clone());
        all_notices.extend(source_notices.clone());
        emit_provider_import_scan_event(
            &app,
            ImportScanProgressEvent {
                scan_id: session.id.clone(),
                phase: "source-complete".to_string(),
                source_key,
                source_label: source_label.clone(),
                status: if found > 0 { "found" } else { "empty" }.to_string(),
                message: if found > 0 {
                    format!("{}：找到 {} 个候选供应商", source_label, found)
                } else {
                    format!("{}：没有可直接导入的供应商", source_label)
                },
                completed: idx + 1,
                total,
                found,
                candidates: source_candidates,
                notices: source_notices,
                done: false,
                cancelled: false,
            },
        );
    }

    finalize_import_scan_candidates(&mut all_candidates);
    emit_provider_import_scan_event(
        &app,
        ImportScanProgressEvent {
            scan_id: session.id.clone(),
            phase: "complete".to_string(),
            source_key: String::new(),
            source_label: String::new(),
            status: "complete".to_string(),
            message: format!("扫描完成：{} 个候选供应商", all_candidates.len()),
            completed: total,
            total,
            found: all_candidates.len(),
            candidates: all_candidates,
            notices: all_notices,
            done: true,
            cancelled: false,
        },
    );
    clear_provider_import_scan_session(&state, &session.id);
}

pub(super) fn scan_provider_import_source(source_key: &str) -> (Vec<ImportProviderCandidate>, Vec<String>) {
    let mut candidates = Vec::new();
    let mut notices = Vec::new();
    match source_key {
        "cc-switch" => scan_cc_switch(&mut candidates, &mut notices),
        "cockpit-tools" => scan_cockpit_tools(&mut candidates, &mut notices),
        "cherry-studio" => scan_cherry_studio(&mut candidates, &mut notices),
        _ => notices.push(format!("未知扫描来源：{}", source_key)),
    }
    (candidates, notices)
}

pub(super) fn emit_provider_import_cancelled(app: &AppHandle, scan_id: &str, completed: usize, total: usize) {
    emit_provider_import_scan_event(
        app,
        ImportScanProgressEvent {
            scan_id: scan_id.to_string(),
            phase: "cancelled".to_string(),
            source_key: String::new(),
            source_label: String::new(),
            status: "cancelled".to_string(),
            message: "扫描已取消".to_string(),
            completed,
            total,
            found: 0,
            candidates: Vec::new(),
            notices: Vec::new(),
            done: true,
            cancelled: true,
        },
    );
}

pub(super) fn emit_provider_import_scan_event(app: &AppHandle, payload: ImportScanProgressEvent) {
    let _ = app.emit("provider-import-scan-progress", payload);
}

pub(super) fn clear_provider_import_scan_session(state: &ProviderImportScanState, scan_id: &str) {
    if let Ok(mut active) = state.active.lock() {
        if active.as_ref().map(|s| s.id.as_str()) == Some(scan_id) {
            *active = None;
        }
    }
}

pub(super) fn new_provider_import_scan_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    format!("provider-import-{}", millis)
}

pub(super) fn selected_import_sources(sources: Option<Vec<String>>) -> HashSet<String> {
    selected_import_source_keys(sources).into_iter().collect()
}

pub(super) fn selected_import_source_keys(sources: Option<Vec<String>>) -> Vec<String> {
    let selected: HashSet<String> = sources
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| ALL_IMPORT_SOURCE_KEYS.contains(&s.as_str()))
        .collect();
    if selected.is_empty() {
        ALL_IMPORT_SOURCE_KEYS
            .into_iter()
            .map(str::to_string)
            .collect()
    } else {
        ALL_IMPORT_SOURCE_KEYS
            .into_iter()
            .filter(|key| selected.contains(*key))
            .map(str::to_string)
            .collect()
    }
}

pub(super) fn provider_import_source_label(key: &str) -> &str {
    match key {
        "cc-switch" => "CC Switch",
        "cockpit-tools" => "Cockpit Tools",
        "cherry-studio" => "Cherry Studio",
        _ => key,
    }
}

pub(super) fn finalize_import_scan_candidates(candidates: &mut Vec<ImportProviderCandidate>) {
    let mut seen = HashSet::new();
    candidates.retain(|c| seen.insert(candidate_signature(c)));
    candidates.sort_by(|a, b| {
        a.source
            .cmp(&b.source)
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.api_host.cmp(&b.api_host))
    });
}

#[tauri::command]
pub async fn import_providers(
    candidates: Vec<ImportProviderCandidate>,
) -> Result<ImportProvidersResult, String> {
    tauri::async_runtime::spawn_blocking(move || import_providers_sync(candidates))
        .await
        .map_err(|e| format!("导入供应商任务失败: {e}"))?
}

fn import_providers_sync(
    candidates: Vec<ImportProviderCandidate>,
) -> Result<ImportProvidersResult, String> {
    crate::commands::store_io::update_provider_store(|store| {
        let mut imported = 0;
        let mut skipped = 0;
        let mut messages = Vec::new();

        for candidate in candidates {
            if candidate.api_host.trim().is_empty() || candidate.api_key.trim().is_empty() {
                skipped += 1;
                messages.push(format!("跳过 {}：缺少 API 地址或密钥", candidate.name));
                continue;
            }
            if provider_exists(store, &candidate) {
                skipped += 1;
                messages.push(format!(
                    "跳过 {}：已存在相同地址和密钥的供应商",
                    candidate.name
                ));
                continue;
            }

            let provider = Provider {
                id: unique_provider_id(store, &candidate.id),
                name: unique_provider_name(store, &candidate.name),
                api_host: candidate.api_host.trim_end_matches('/').to_string(),
                api_key: candidate.api_key,
                api_keys: Vec::new(),
                api_path: candidate.api_path.filter(|p| !p.trim().is_empty()),
                default_model: candidate.default_model,
                api_format: Some(candidate.api_format),
                route_through_proxy: true,
                inject_models: true,
                preserve_official_auth: false,
                unify_session_history: true,
                enabled: true,
                models: unique_strings(candidate.models),
                capabilities: normalize_caps(candidate.capabilities),
                model_caps: candidate.model_caps,
                unlocks: Default::default(),
                wire_api: String::new(),
                model_catalog: Vec::new(),
                codex_chat_reasoning: None,
                agents_config: None,
                agents: Vec::new(),
                context_window: None,
                model_contexts: HashMap::new(),
                subagent_models: HashMap::new(),
            };
            store.providers.push(provider);
            imported += 1;
        }

        let out_store = store.clone();
        Ok((
            imported > 0,
            ImportProvidersResult {
                imported,
                skipped,
                store: out_store,
                messages,
            },
        ))
    })
}


mod cherry_leveldb;
mod normalize;
mod sources;
use cherry_leveldb::*;
use normalize::*;
use sources::*;

#[cfg(test)]
mod tests;
