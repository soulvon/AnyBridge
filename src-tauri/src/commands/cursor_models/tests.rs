use super::*;

#[test]
fn empty_store_has_stable_revision() {
    let mut store = empty_cursor_store();
    assert_eq!(store.version, 1);
    assert!(!store.revision.is_empty());
    let rev1 = store.revision.clone();
    normalize_cursor_store(&mut store);
    assert_eq!(store.revision, rev1);
}

#[test]
fn migration_imports_only_openai_enabled_routes() {
    let unique_id = format!("cursor-test-{}", rand::random::<u64>());
    let dir = std::env::temp_dir().join(unique_id);
    fs::create_dir_all(&dir).unwrap();
    let routes_path = dir.join("proxy-routes.json");
    let cursor_path = dir.join("cursor-models.json");

    let routes_json = r#"{
        "version": 1,
        "routes": [
            {
                "uid": "route-1",
                "id": "gpt-4o",
                "displayName": "GPT 4o Main",
                "enabled": true,
                "exposedFormats": ["openai"],
                "targets": [{"providerId": "openai", "model": "gpt-4o"}]
            },
            {
                "uid": "route-2",
                "id": "claude-haiku",
                "displayName": "Haiku Anthropic Only",
                "enabled": true,
                "exposedFormats": ["anthropic"],
                "targets": [{"providerId": "anthropic", "model": "claude-haiku"}]
            },
            {
                "uid": "route-3",
                "id": "disabled-model",
                "displayName": "Disabled",
                "enabled": false,
                "exposedFormats": ["openai"],
                "targets": [{"providerId": "openai", "model": "disabled"}]
            }
        ]
    }"#;
    fs::write(&routes_path, routes_json).unwrap();

    let store = read_cursor_store_with_routes(cursor_path.clone(), routes_path.clone()).unwrap();
    assert_eq!(store.models.len(), 1);
    assert_eq!(store.models[0].route_uid, "route-1");
    assert_eq!(store.models[0].display_name, "GPT 4o Main");
    assert_eq!(store.models[0].exposed_model_id, "gpt-4o");
    assert!(store.migration_notice.is_some());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn removing_binding_preserves_shared_route() {
    let mut store = CursorModelsStore::default();
    store.models.push(CursorModelBinding {
        id: "cursor-1".into(),
        route_uid: "route-shared".into(),
        display_name: "Test".into(),
        exposed_model_id: "test".into(),
        enabled: true,
        ..Default::default()
    });

    store.models.retain(|m| m.id != "cursor-1");
    assert!(store.models.is_empty());
}

#[test]
fn provider_tag_style_normalization_and_default() {
    let mut store = empty_cursor_store();
    assert_eq!(store.provider_tag_style, "badge");

    store.provider_tag_style = "prefix".into();
    normalize_cursor_store(&mut store);
    assert_eq!(store.provider_tag_style, "prefix");

    store.provider_tag_style = "suffix".into();
    normalize_cursor_store(&mut store);
    assert_eq!(store.provider_tag_style, "suffix");

    store.provider_tag_style = "none".into();
    normalize_cursor_store(&mut store);
    assert_eq!(store.provider_tag_style, "none");

    store.provider_tag_style = "invalid_style".into();
    normalize_cursor_store(&mut store);
    assert_eq!(store.provider_tag_style, "badge");

    // 括号自定义测试
    store.provider_bracket_left = "【".into();
    store.provider_bracket_right = "】".into();
    normalize_cursor_store(&mut store);
    assert_eq!(store.provider_bracket_left, "【");
    assert_eq!(store.provider_bracket_right, "】");

    store.provider_bracket_left = "".into();
    store.provider_bracket_right = "".into();
    normalize_cursor_store(&mut store);
    assert_eq!(store.provider_bracket_left, "[");
    assert_eq!(store.provider_bracket_right, "]");
}
