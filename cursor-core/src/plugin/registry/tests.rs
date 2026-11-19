use std::path::PathBuf;

use serde_json::json;

use super::super::{
    catalog::PluginEntry,
    descriptor::{PluginModuleDefinition, ProviderDefinition, ResourceDefinition},
    manifest::{PluginManifest, PluginPermissions, PLUGIN_API_VERSION},
};
use super::{find_provider, find_resource, oauth::oauth_random_secret};

fn sample_entry() -> PluginEntry {
    PluginEntry {
        directory: PathBuf::from("."),
        entry: PathBuf::from("index.js"),
        manifest: PluginManifest {
            api_version: PLUGIN_API_VERSION,
            id: "demo".into(),
            name: "Demo".into(),
            version: "1.0.0".into(),
            author: None,
            min_app_version: None,
            icon: String::new(),
            entry: "index.js".into(),
            permissions: PluginPermissions::default(),
        },
        definition: PluginModuleDefinition {
            providers: vec![ProviderDefinition {
                id: "prov".into(),
                display_name: json!("Provider"),
                description: json!(null),
                provider_type: "openai".into(),
                resource_type: None,
                has_models: true,
            }],
            resources: vec![ResourceDefinition {
                resource_type: "account".into(),
                display_name: json!("Account"),
                add: Vec::new(),
                import: None,
                actions: Vec::new(),
                can_refresh: false,
                can_remove: false,
            }],
        },
        icon: String::new(),
    }
}

#[test]
fn find_provider_and_resource_validate_declared_ids() {
    let entry = sample_entry();
    assert!(find_provider(&entry, "prov").is_ok());
    assert!(find_provider(&entry, "missing").is_err());
    assert!(find_resource(&entry, "account").is_ok());
    assert!(find_resource(&entry, "missing").is_err());
}

#[test]
fn oauth_random_secret_generates_non_empty_url_safe_tokens() {
    let a = oauth_random_secret();
    let b = oauth_random_secret();
    assert!(!a.is_empty());
    assert_ne!(a, b);
    assert!(!a.contains('='));
}
