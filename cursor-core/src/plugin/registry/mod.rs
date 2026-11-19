//! Orchestrates plugin capabilities: resources, model catalogs, and invocation.
use std::{collections::HashMap, path::Path, sync::Arc};

use async_stream::try_stream;
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;

use super::{
    catalog::{PluginCatalog, PluginEntry},
    data::PluginDataStore,
    descriptor::{
        parse_model_id, PluginDescriptor, PluginModelDescriptor, PluginProviderDescriptor,
        PluginResourceDescriptor, ProviderDefinition, ResourceDefinition,
    },
    runtime::PluginRuntime,
    state::{now_ms, PluginStateStore, ResourcePatch, ResourceRecord, StoredModel},
    wire,
    worker::{PluginWorker, WorkerStreamItem},
};
use crate::{
    model::ModelInvocation,
    provider::ProviderStream,
    provider::{CallRecorder, ModelEvent},
    store::Store,
    Error, Result,
};


mod oauth;
mod resources;
#[cfg(test)]
mod tests;

pub use oauth::{OAuthBeginResponse, OAuthPollResponse};
pub use resources::ImportResponse;

use oauth::OAuthSession;

#[derive(Clone)]
pub struct PluginRegistry {
    pub(super) inner: Arc<RegistryInner>,
}

pub(super) struct RegistryInner {
    pub(super) store: Store,
    pub(super) runtime: PluginRuntime,
    pub(super) catalog: PluginCatalog,
    pub(super) state: PluginStateStore,
    entries: RwLock<Option<Vec<PluginEntry>>>,
    workers: Mutex<HashMap<String, Arc<PluginWorker>>>,
    pub(in crate::plugin::registry) oauth_sessions: Mutex<HashMap<String, OAuthSession>>,
}

/// 路由分支在建立 Recorder 时需要的插件模型元数据。
#[derive(Clone, Debug)]
pub struct PluginInvocationPlan {
    pub model: PluginModelDescriptor,
    pub request_url: String,
}

impl PluginRegistry {
    pub fn managed(store: Store, runtime: PluginRuntime, app_version: String) -> Result<Self> {
        let data = PluginDataStore::managed()?;
        Ok(Self {
            inner: Arc::new(RegistryInner {
                store,
                runtime,
                catalog: PluginCatalog::managed(app_version)?,
                state: PluginStateStore::new(data),
                entries: RwLock::new(None),
                workers: Mutex::new(HashMap::new()),
                oauth_sessions: Mutex::new(HashMap::new()),
            }),
        })
    }

    pub async fn plugins(&self) -> Vec<PluginDescriptor> {
        let Some(executable) = self.inner.runtime.executable() else {
            return self
                .inner
                .catalog
                .manifests()
                .into_iter()
                .map(|(manifest, icon)| PluginDescriptor {
                    id: manifest.id,
                    name: manifest.name,
                    version: manifest.version,
                    author: manifest.author,
                    icon,
                    providers: Vec::new(),
                    resources: Vec::new(),
                })
                .collect();
        };
        let mut plugins = Vec::new();
        for entry in self.entries(&executable).await {
            plugins.push(self.descriptor(&entry, &executable).await);
        }
        plugins
    }

    /// 已满足调用条件的全部插件模型;每个模型独立进入 Cursor 目录。
    pub async fn configured_models(&self) -> Vec<PluginModelDescriptor> {
        let Some(executable) = self.inner.runtime.executable() else {
            return Vec::new();
        };
        let mut models = Vec::new();
        for entry in self.entries(&executable).await {
            for provider in &entry.definition.providers {
                if !self.provider_configured(&entry, provider).await {
                    continue;
                }
                let stored = self
                    .inner
                    .state
                    .models(&entry.manifest.id, &provider.id)
                    .await
                    .unwrap_or_default();
                models.extend(stored.iter().filter(|model| model.enabled).map(|model| {
                    PluginModelDescriptor::new(
                        &entry.manifest.id,
                        &entry.manifest.name,
                        &entry.icon,
                        provider,
                        model,
                    )
                }));
            }
        }
        models
    }

    pub async fn model_descriptor(&self, model_id: &str) -> Result<PluginModelDescriptor> {
        let (plugin_id, provider_id, upstream_id) = parse_model_id(model_id)
            .ok_or_else(|| Error::Provider(format!("invalid plugin model ID: {model_id}")))?;
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await?;
        let provider = find_provider(&entry, provider_id)?;
        let stored = self
            .inner
            .state
            .models(plugin_id, provider_id)
            .await?
            .into_iter()
            .find(|model| model.id == upstream_id)
            .ok_or_else(|| Error::RunNotFound(format!("plugin model {model_id}")))?;
        Ok(PluginModelDescriptor::new(
            plugin_id,
            &entry.manifest.name,
            &entry.icon,
            provider,
            &stored,
        ))
    }

    pub async fn plan_model(&self, model_id: &str) -> Result<PluginInvocationPlan> {
        let model = self.model_descriptor(model_id).await?;
        let request_url = format!("plugin://{}/{}", model.plugin_id, model.provider_id);
        Ok(PluginInvocationPlan { model, request_url })
    }

    /// 插件模型的统一 Provider 流:选首个可用资源,经 Worker 执行,
    /// 事件与内置 Provider 走同一管道。未来的负载均衡在这里换资源重试。
    pub fn stream_model(
        &self,
        invocation: ModelInvocation,
        cancellation: CancellationToken,
        recorder: CallRecorder,
    ) -> ProviderStream {
        let registry = self.clone();
        Box::pin(try_stream! {
            let model_id = invocation.request.model.model_id.clone();
            let (plugin_id, provider_id, upstream_id) = parse_model_id(&model_id)
                .map(|(plugin, provider, model)| (plugin.to_owned(), provider.to_owned(), model.to_owned()))
                .ok_or_else(|| Error::Provider(format!("invalid plugin model ID: {model_id}")))?;
            let executable = registry.executable()?;
            let entry = registry.find_entry(&executable, &plugin_id).await?;
            let provider = find_provider(&entry, &provider_id)?.clone();
            let stored = registry.inner.state.models(&plugin_id, &provider_id).await?
                .into_iter()
                .find(|model| model.id == upstream_id)
                .ok_or_else(|| Error::RunNotFound(format!("plugin model {model_id}")))?;
            let resource = match &provider.resource_type {
                Some(resource_type) => Some((
                    resource_type.clone(),
                    registry.select_resource(&plugin_id, resource_type).await?,
                )),
                None => None,
            };
            let request = wire::llm_request(&invocation)?;
            let params = serde_json::json!({
                "providerId": provider_id,
                "model": stored.snapshot(),
                "resource": resource.as_ref().map(|(resource_type, record)| record.snapshot(resource_type)),
                "request": request,
            });
            let worker = registry.worker(&entry, &executable).await;
            let mut items = worker.invoke_streaming("provider.invoke", params, cancellation.clone(), Some(recorder)).await?;
            yield ModelEvent::Start { model_call_id: invocation.call_id.clone() };
            while let Some(item) = items.recv().await {
                match item {
                    WorkerStreamItem::Event(event) => {
                        yield wire::model_event(&event)?;
                    }
                    WorkerStreamItem::Result(result) => {
                        let value = result?;
                        let status = value.get("status").and_then(serde_json::Value::as_str).unwrap_or_default();
                        let patch = value.get("patch")
                            .filter(|patch| !patch.is_null())
                            .map(|patch| serde_json::from_value::<ResourcePatch>(patch.clone()))
                            .transpose()?;
                        if let (Some(patch), Some((resource_type, record))) = (patch, resource.as_ref()) {
                            if let Err(error) = registry.inner.state
                                .apply_patch(&plugin_id, resource_type, &record.id, patch).await
                            {
                                tracing::warn!(plugin = %plugin_id, %error, "failed to apply plugin resource patch");
                            }
                        }
                        match status {
                            "completed" => return,
                            "resource-error" | "request-error" => {
                                let message = value.get("message")
                                    .and_then(serde_json::Value::as_str)
                                    .unwrap_or("plugin provider call failed");
                                Err(Error::Provider(message.to_owned()))?;
                            }
                            status => {
                                Err(Error::Protocol(format!("unknown plugin provider result: {status}")))?;
                            }
                        }
                    }
                }
            }
            Err(Error::Provider(format!("plugin '{plugin_id}' worker stopped mid-stream")))?;
        })
    }

    pub async fn sync_models(&self, plugin_id: &str, provider_id: &str) -> Result<usize> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await?;
        let provider = find_provider(&entry, provider_id)?.clone();
        self.sync_provider_models(&entry, &executable, &provider)
            .await
    }

    pub async fn set_model_enabled(
        &self,
        plugin_id: &str,
        provider_id: &str,
        model_id: &str,
        enabled: bool,
    ) -> Result<()> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await?;
        let provider = find_provider(&entry, provider_id)?;
        if !provider.has_models {
            return Err(Error::Config(format!(
                "plugin provider '{provider_id}' does not enumerate models"
            )));
        }
        self.inner
            .state
            .set_model_enabled(plugin_id, provider_id, model_id, enabled)
            .await
    }

    pub async fn remove(&self, plugin_id: &str) -> Result<()> {
        if let Some(worker) = self.inner.workers.lock().await.remove(plugin_id) {
            worker.stop().await;
        }
        self.inner.state.clear(plugin_id).await
    }

    async fn descriptor(&self, entry: &PluginEntry, executable: &Path) -> PluginDescriptor {
        let plugin_id = &entry.manifest.id;
        let mut providers = Vec::new();
        for provider in &entry.definition.providers {
            let stored = self
                .inner
                .state
                .models(plugin_id, &provider.id)
                .await
                .unwrap_or_default();
            let configured = self.provider_configured(entry, provider).await;
            providers.push(PluginProviderDescriptor {
                id: provider.id.clone(),
                plugin_id: plugin_id.clone(),
                display_name: provider.display_name.clone(),
                description: provider.description.clone(),
                provider_type: provider.provider_type.clone(),
                resource_type: provider.resource_type.clone(),
                has_models: provider.has_models,
                configured,
                models: stored
                    .iter()
                    .map(|model| {
                        PluginModelDescriptor::new(
                            plugin_id,
                            &entry.manifest.name,
                            &entry.icon,
                            provider,
                            model,
                        )
                    })
                    .collect(),
            });
        }
        let mut resources = Vec::new();
        for definition in &entry.definition.resources {
            let records = self
                .inner
                .state
                .resources(plugin_id, &definition.resource_type)
                .await
                .unwrap_or_default();
            let views = self
                .present_resources(entry, executable, definition, &records)
                .await;
            resources.push(PluginResourceDescriptor {
                resource_type: definition.resource_type.clone(),
                display_name: definition.display_name.clone(),
                add: definition.add.clone(),
                import: definition.import.clone(),
                actions: definition.actions.clone(),
                can_refresh: definition.can_refresh,
                can_remove: definition.can_remove,
                resources: views,
            });
        }
        PluginDescriptor {
            id: plugin_id.clone(),
            name: entry.manifest.name.clone(),
            version: entry.manifest.version.clone(),
            author: entry.manifest.author.clone(),
            icon: entry.icon.clone(),
            providers,
            resources,
        }
    }


    pub(super) async fn provider_configured(
        &self,
        entry: &PluginEntry,
        provider: &ProviderDefinition,
    ) -> bool {
        let plugin_id = &entry.manifest.id;
        if provider.has_models {
            let models = self
                .inner
                .state
                .models(plugin_id, &provider.id)
                .await
                .unwrap_or_default();
            if models.is_empty() {
                return false;
            }
        }
        match &provider.resource_type {
            Some(resource_type) => !self
                .inner
                .state
                .resources(plugin_id, resource_type)
                .await
                .unwrap_or_default()
                .is_empty(),
            None => true,
        }
    }

    /// 资源到位后刷新使用该资源类型的 Provider 模型目录;失败只报告不中断。
    pub(super) async fn sync_provider_models_for_resource(
        &self,
        entry: &PluginEntry,
        executable: &Path,
        resource_type: &str,
    ) -> Option<String> {
        let mut errors = Vec::new();
        for provider in entry.definition.providers.clone() {
            if provider.resource_type.as_deref() != Some(resource_type) || !provider.has_models {
                continue;
            }
            if let Err(error) = self
                .sync_provider_models(entry, executable, &provider)
                .await
            {
                errors.push(format!("{}: {error}", provider.id));
            }
        }
        (!errors.is_empty()).then(|| errors.join("; "))
    }

    pub(super) async fn sync_provider_models(
        &self,
        entry: &PluginEntry,
        executable: &Path,
        provider: &ProviderDefinition,
    ) -> Result<usize> {
        if !provider.has_models {
            return Err(Error::Config(format!(
                "plugin provider '{}' does not enumerate models",
                provider.id
            )));
        }
        let plugin_id = &entry.manifest.id;
        let resource = match &provider.resource_type {
            Some(resource_type) => {
                let record = self.select_resource(plugin_id, resource_type).await?;
                Some(record.snapshot(resource_type))
            }
            None => None,
        };
        let value = self
            .worker(entry, executable)
            .await
            .invoke(
                "models.list",
                serde_json::json!({ "providerId": provider.id, "resource": resource }),
                CancellationToken::new(),
            )
            .await?;
        let definitions = value
            .as_array()
            .ok_or_else(|| Error::Protocol("plugin models.list must return an array".into()))?;
        let mut models = Vec::with_capacity(definitions.len());
        let mut seen = std::collections::HashSet::new();
        for definition in definitions {
            let model = StoredModel::from_definition(definition)?;
            if seen.insert(model.id.clone()) {
                models.push(model);
            }
        }
        if models.is_empty() {
            return Err(Error::Provider(format!(
                "plugin provider '{}' returned no models",
                provider.id
            )));
        }
        self.inner
            .state
            .replace_models(plugin_id, &provider.id, &models)
            .await?;
        Ok(models.len())
    }

    /// 第一版选择策略:按创建顺序取首个可用资源;冷却到期视为可用。
    pub(super) async fn select_resource(
        &self,
        plugin_id: &str,
        resource_type: &str,
    ) -> Result<ResourceRecord> {
        let records = self.inner.state.resources(plugin_id, resource_type).await?;
        if records.is_empty() {
            return Err(Error::Provider(format!(
                "plugin '{plugin_id}' has no '{resource_type}' resource; add one first"
            )));
        }
        let now = now_ms();
        records
            .iter()
            .find(|record| record.state.is_ready(now))
            .or_else(|| records.first())
            .cloned()
            .ok_or_else(|| Error::Provider("no plugin resource is available".into()))
    }

    pub(super) fn executable(&self) -> Result<std::path::PathBuf> {
        self.inner
            .runtime
            .executable()
            .ok_or_else(|| Error::Config("plugin runtime is not ready".into()))
    }

    pub(super) async fn entries(&self, executable: &Path) -> Vec<PluginEntry> {
        if let Some(entries) = self.inner.entries.read().await.as_ref() {
            return entries.clone();
        }
        let loaded = self.inner.catalog.entries(executable).await;
        *self.inner.entries.write().await = Some(loaded.clone());
        loaded
    }

    pub(super) async fn find_entry(&self, executable: &Path, plugin_id: &str) -> Result<PluginEntry> {
        self.entries(executable)
            .await
            .into_iter()
            .find(|entry| entry.manifest.id == plugin_id)
            .ok_or_else(|| Error::RunNotFound(format!("plugin {plugin_id}")))
    }

    pub(super) async fn worker(&self, entry: &PluginEntry, executable: &Path) -> Arc<PluginWorker> {
        let mut workers = self.inner.workers.lock().await;
        workers
            .entry(entry.manifest.id.clone())
            .or_insert_with(|| {
                Arc::new(PluginWorker::new(
                    entry,
                    executable.to_path_buf(),
                    self.inner.catalog.loader().clone(),
                    self.inner.store.clone(),
                ))
            })
            .clone()
    }
}

pub(super) fn find_provider<'a>(entry: &'a PluginEntry, provider_id: &str) -> Result<&'a ProviderDefinition> {
    entry
        .definition
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| {
            Error::RunNotFound(format!(
                "plugin '{}' provider {provider_id}",
                entry.manifest.id
            ))
        })
}

pub(super) fn find_resource<'a>(
    entry: &'a PluginEntry,
    resource_type: &str,
) -> Result<&'a ResourceDefinition> {
    entry
        .definition
        .resources
        .iter()
        .find(|resource| resource.resource_type == resource_type)
        .ok_or_else(|| {
            Error::RunNotFound(format!(
                "plugin '{}' resource type {resource_type}",
                entry.manifest.id
            ))
        })
}
