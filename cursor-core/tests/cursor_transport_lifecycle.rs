//! Verifies registry ownership follows the transport actor rather than output subscriptions.

#[path = "support/fake_provider.rs"]
mod fake_provider;
#[path = "support/fixtures.rs"]
mod fixtures;

use std::{sync::Arc, time::Duration};

use cursor_server::cursor::{
    conversation::TransportCommand,
    prompting::{PromptAssets, PromptCompiler},
    transport::TransportRegistry,
};

async fn registry() -> (tempfile::TempDir, TransportRegistry) {
    let (directory, store) = fixtures::temp_store().await;
    let assets = PromptAssets::load(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("prompt/cursor")
            .as_path(),
    )
    .unwrap();
    (
        directory,
        TransportRegistry::new(
            store,
            Arc::new(fake_provider::FakeProvider::default()),
            PromptCompiler::new(assets),
        ),
    )
}

#[tokio::test]
async fn actor_exit_removes_the_matching_transport_and_allows_a_new_generation() {
    let (_directory, registry) = registry().await;
    let first = registry.get_or_create("lifecycle-request").await.unwrap();
    assert!(registry.local("lifecycle-request").await.is_some());

    first.command(TransportCommand::Disconnect).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if registry.local("lifecycle-request").await.is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();

    let second = registry.get_or_create("lifecycle-request").await.unwrap();
    assert_eq!(second.request_id(), "lifecycle-request");
    assert!(registry.local("lifecycle-request").await.is_some());
    second.command(TransportCommand::Disconnect).await.unwrap();
}

#[tokio::test]
async fn dropping_an_output_subscription_does_not_remove_the_transport() {
    let (_directory, registry) = registry().await;
    let handle = registry
        .get_or_create("subscription-request")
        .await
        .unwrap();
    let subscription = handle.subscribe();
    drop(subscription);

    tokio::time::sleep(Duration::from_millis(25)).await;
    assert!(registry.local("subscription-request").await.is_some());

    handle.command(TransportCommand::Disconnect).await.unwrap();
}
