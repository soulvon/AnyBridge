use cursor_server::{
    anybridge::sync_routes_to_store,
    store::Store,
};

#[tokio::test]
async fn route_sync_replaces_stale_models_atomically() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("cursor-core.db");
    let routes = directory.path().join("proxy-routes.json");
    let store = Store::connect(&format!("sqlite://{}", database.display()))
        .await
        .unwrap();

    std::fs::write(
        &routes,
        r#"{"routes":[{"id":"first","displayName":"First","enabled":true,"exposedFormats":["openai"],"targets":[{"providerId":"p","model":"m"}]}]}"#,
    )
    .unwrap();
    sync_routes_to_store(&store, &routes, "http://127.0.0.1:7450", "key")
        .await
        .unwrap();
    assert_eq!(store.models().await.unwrap()[0].model_id, "first");

    std::fs::write(
        &routes,
        r#"{"routes":[{"id":"second","displayName":"Second","enabled":true,"exposedFormats":["openai"],"targets":[{"providerId":"p","model":"m"}]}]}"#,
    )
    .unwrap();
    sync_routes_to_store(&store, &routes, "http://127.0.0.1:7450", "key")
        .await
        .unwrap();

    let models = store.models().await.unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].model_id, "second");
}
