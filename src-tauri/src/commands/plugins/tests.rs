use super::*;
use std::collections::HashSet;

#[test]
fn plugin_provider_id_is_namespaced() {
    assert_eq!(plugin_provider_id("aistudio2api"), "plugin-aistudio2api");
}

#[test]
fn orphan_ids_only_target_removed_plugins() {
    let ids = vec![
        "plugin-aistudio2api".to_string(),
        "plugin-gone".to_string(),
        "plugin-multi2api".to_string(),
        "p-user-created".to_string(),
        "anybridge-local-proxy".to_string(),
    ];
    let valid: HashSet<String> = ["aistudio2api".to_string(), "multi2api".to_string()]
        .into_iter()
        .collect();
    assert_eq!(
        orphan_plugin_provider_ids(&ids, &valid),
        vec!["plugin-gone".to_string()],
        "只清理已不存在的插件留下的托管供应商，用户自建条目一律不动"
    );
}

#[test]
fn empty_installed_plugin_set_removes_all_plugin_providers() {
    let ids = vec![
        "plugin-a".to_string(),
        "plugin-b".to_string(),
        "user".to_string(),
    ];
    assert_eq!(
        orphan_plugin_provider_ids(&ids, &HashSet::<String>::new()),
        vec!["plugin-a".to_string(), "plugin-b".to_string()]
    );
}
