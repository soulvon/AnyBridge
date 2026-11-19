use std::path::Path;

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use super::super::{
    catalog::PluginEntry,
    descriptor::{
        PluginResourceView, ResourceActionResponse, ResourceActionResult, ResourceDefinition,
        ResourcePresentation,
    },
    state::{ResourceDraft, ResourcePatch, ResourceRecord},
};
use super::{find_resource, PluginRegistry};
use crate::{Error, Result};

const MAX_IMPORT_DRAFTS: usize = 256;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResponse {
    pub added: usize,
    pub updated: usize,
    pub warnings: Vec<String>,
    pub model_sync_error: Option<String>,
}

impl PluginRegistry {
    pub async fn import_resources(
        &self,
        plugin_id: &str,
        resource_type: &str,
        files: serde_json::Value,
    ) -> Result<ImportResponse> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await?;
        let resource = find_resource(&entry, resource_type)?;
        if resource.import.is_none() {
            return Err(Error::Config(format!(
                "plugin '{plugin_id}' resource '{resource_type}' does not support import"
            )));
        }
        let value = self
            .worker(&entry, &executable)
            .await
            .invoke(
                "import.parse",
                serde_json::json!({ "resourceType": resource_type, "files": files }),
                CancellationToken::new(),
            )
            .await?;
        let parsed: ImportParseResult = serde_json::from_value(value)?;
        if parsed.resources.is_empty() {
            return Err(Error::Config(
                parsed
                    .warnings
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "import produced no resources".into()),
            ));
        }
        if parsed.resources.len() > MAX_IMPORT_DRAFTS {
            return Err(Error::Config(format!(
                "import produced more than {MAX_IMPORT_DRAFTS} resources"
            )));
        }
        let outcome = self
            .inner
            .state
            .upsert_resources(plugin_id, resource_type, parsed.resources)
            .await?;
        let model_sync_error = self
            .sync_provider_models_for_resource(&entry, &executable, resource_type)
            .await;
        Ok(ImportResponse {
            added: outcome.added,
            updated: outcome.updated,
            warnings: parsed.warnings,
            model_sync_error,
        })
    }

    /// 导出某资源类型的全部私有数据,供备份或迁移;格式与批量导入兼容。
    pub async fn export_resources(
        &self,
        plugin_id: &str,
        resource_type: &str,
    ) -> Result<serde_json::Value> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await?;
        find_resource(&entry, resource_type)?;
        let records = self.inner.state.resources(plugin_id, resource_type).await?;
        Ok(serde_json::json!({
            "accounts": records
                .iter()
                .map(|record| record.private_data.clone())
                .collect::<Vec<_>>(),
        }))
    }

    pub async fn refresh_resource(
        &self,
        plugin_id: &str,
        resource_type: &str,
        resource_id: &str,
    ) -> Result<()> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await?;
        let resource = find_resource(&entry, resource_type)?;
        if !resource.can_refresh {
            return Err(Error::Config(format!(
                "plugin '{plugin_id}' resource '{resource_type}' does not support refresh"
            )));
        }
        let record = self
            .find_record(plugin_id, resource_type, resource_id)
            .await?;
        let value = self
            .worker(&entry, &executable)
            .await
            .invoke(
                "resource.refresh",
                serde_json::json!({
                    "resourceType": resource_type,
                    "resource": record.snapshot(resource_type),
                }),
                CancellationToken::new(),
            )
            .await?;
        let patch: ResourcePatch = serde_json::from_value(value)?;
        self.inner
            .state
            .apply_patch(plugin_id, resource_type, resource_id, patch)
            .await
    }

    pub async fn resource_action(
        &self,
        plugin_id: &str,
        resource_type: &str,
        resource_id: &str,
        action_id: &str,
        input: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await?;
        let resource = find_resource(&entry, resource_type)?;
        let action = resource
            .actions
            .iter()
            .find(|action| action.id == action_id)
            .ok_or_else(|| {
                Error::Config(format!(
                    "plugin '{plugin_id}' resource '{resource_type}' does not define action '{action_id}'"
                ))
            })?;
        if !matches!(action.target.as_str(), "resource" | "card") {
            return Err(Error::Config(format!(
                "plugin '{plugin_id}' resource action '{action_id}' has an invalid target"
            )));
        }
        let record = self
            .find_record(plugin_id, resource_type, resource_id)
            .await?;
        let value = self
            .worker(&entry, &executable)
            .await
            .invoke(
                "resource.action",
                serde_json::json!({
                    "resourceType": resource_type,
                    "actionId": action_id,
                    "resource": record.snapshot(resource_type),
                    "input": input,
                }),
                CancellationToken::new(),
            )
            .await?;
        let result: ResourceActionResult = serde_json::from_value(value)?;
        if let Some(patch) = result.patch.clone() {
            self.inner
                .state
                .apply_patch(plugin_id, resource_type, resource_id, patch)
                .await?;
        }
        Ok(serde_json::to_value(ResourceActionResponse::from(result))?)
    }

    pub async fn delete_resource(
        &self,
        plugin_id: &str,
        resource_type: &str,
        resource_id: &str,
    ) -> Result<()> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await?;
        let resource = find_resource(&entry, resource_type)?;
        let record = self
            .find_record(plugin_id, resource_type, resource_id)
            .await?;
        if resource.can_remove {
            // 上游撤销失败不阻塞本地删除:用户必须能移除已失效的资源。
            if let Err(error) = self
                .worker(&entry, &executable)
                .await
                .invoke(
                    "resource.remove",
                    serde_json::json!({
                        "resourceType": resource_type,
                        "resource": record.snapshot(resource_type),
                    }),
                    CancellationToken::new(),
                )
                .await
            {
                tracing::warn!(plugin = %plugin_id, %error, "plugin resource remove hook failed");
            }
        }
        self.inner
            .state
            .remove_resource(plugin_id, resource_type, resource_id)
            .await?;
        Ok(())
    }

    pub(super) async fn present_resources(
        &self,
        entry: &PluginEntry,
        executable: &Path,
        definition: &ResourceDefinition,
        records: &[ResourceRecord],
    ) -> Vec<PluginResourceView> {
        if records.is_empty() {
            return Vec::new();
        }
        let snapshots = records
            .iter()
            .map(|record| record.snapshot(&definition.resource_type))
            .collect::<Vec<_>>();
        let presented = self
            .worker(entry, executable)
            .await
            .invoke(
                "resource.present",
                serde_json::json!({
                    "resourceType": definition.resource_type,
                    "resources": snapshots,
                }),
                CancellationToken::new(),
            )
            .await
            .and_then(|value| {
                serde_json::from_value::<Vec<ResourcePresentation>>(value).map_err(Error::from)
            });
        match presented {
            Ok(views) if views.len() == records.len() => records
                .iter()
                .zip(views)
                .map(|(record, view)| PluginResourceView::from_record(record, view))
                .collect(),
            Ok(_) | Err(_) => records
                .iter()
                .map(|record| {
                    PluginResourceView::from_record(
                        record,
                        ResourcePresentation {
                            display_name: record.key.clone(),
                            description: serde_json::Value::Null,
                            metrics: Vec::new(),
                        },
                    )
                })
                .collect(),
        }
    }

    pub(super) async fn find_record(
        &self,
        plugin_id: &str,
        resource_type: &str,
        resource_id: &str,
    ) -> Result<ResourceRecord> {
        self.inner
            .state
            .resources(plugin_id, resource_type)
            .await?
            .into_iter()
            .find(|record| record.id == resource_id)
            .ok_or_else(|| Error::RunNotFound(format!("plugin resource {resource_id}")))
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportParseResult {
    resources: Vec<ResourceDraft>,
    #[serde(default)]
    warnings: Vec<String>,
}
