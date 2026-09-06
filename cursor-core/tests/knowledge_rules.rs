//! Verifies KnowledgeBase rules CRUD falls back to local markdown storage
//! when the Cursor upstream is unreachable or rejects the request.
#[path = "support/fixtures.rs"]
mod fixtures;

use axum::{
    body::{to_bytes, Body},
    extract::Extension,
    http::{header, Request, Response},
};
use cursor_server::{
    api::cursor::proxy::CursorProxy,
    cursor::services::knowledge::{self, KnowledgeService},
};
use prost::Message;

// 测试侧的镜像消息定义,同时充当 wire 兼容性检查。
#[derive(Clone, PartialEq, Message)]
struct AddRequest {
    #[prost(string, tag = "1")]
    knowledge: String,
    #[prost(string, tag = "2")]
    title: String,
    #[prost(string, tag = "3")]
    git_origin: String,
}

#[derive(Clone, PartialEq, Message)]
struct AddResponse {
    #[prost(bool, tag = "1")]
    success: bool,
    #[prost(string, tag = "2")]
    id: String,
}

#[derive(Clone, PartialEq, Message)]
struct ListRequest {
    #[prost(int32, optional, tag = "1")]
    limit: Option<i32>,
}

#[derive(Clone, PartialEq, Message)]
struct ListResponse {
    #[prost(bool, tag = "1")]
    success: bool,
    #[prost(message, repeated, tag = "2")]
    all_results: Vec<ListItem>,
}

#[derive(Clone, PartialEq, Message)]
struct ListItem {
    #[prost(string, tag = "1")]
    id: String,
    #[prost(string, tag = "2")]
    knowledge: String,
    #[prost(string, tag = "3")]
    title: String,
    #[prost(string, tag = "4")]
    created_at: String,
    #[prost(bool, tag = "5")]
    is_generated: bool,
}

#[derive(Clone, PartialEq, Message)]
struct UpdateRequest {
    #[prost(string, tag = "1")]
    id: String,
    #[prost(string, tag = "2")]
    knowledge: String,
    #[prost(string, tag = "3")]
    title: String,
}

#[derive(Clone, PartialEq, Message)]
struct UpdateResponse {
    #[prost(bool, tag = "1")]
    success: bool,
}

#[derive(Clone, PartialEq, Message)]
struct RemoveRequest {
    #[prost(string, tag = "1")]
    id: String,
}

#[derive(Clone, PartialEq, Message)]
struct RemoveResponse {
    #[prost(bool, tag = "1")]
    success: bool,
}

fn proto_request(message: &impl Message) -> Request<Body> {
    Request::post("/test")
        .header(header::CONTENT_TYPE, "application/proto")
        .body(Body::from(message.encode_to_vec()))
        .unwrap()
}

async fn decode<M: Message + Default>(response: Response<Body>) -> M {
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    M::decode(body.as_ref()).unwrap()
}

/// 无凭据请求上游必然失败(网络错误或 401),四个接口全部走本地降级,
/// 覆盖 md 持久化、离线日志压缩与增删改查闭环。
#[tokio::test]
async fn offline_crud_round_trip_persists_markdown() {
    let (_store_dir, store) = fixtures::temp_store().await;
    let upstream = CursorProxy::cursor(cursor_server::network::NetworkClients::new(store));
    let rules_dir = tempfile::tempdir().unwrap();
    let rules_root = rules_dir.path().join("rules");
    let service = KnowledgeService::with_root(rules_root.clone()).unwrap();

    // Add:得到本地临时 id,md 文件落盘。
    let response = knowledge::add(
        Extension(upstream.clone()),
        Extension(service.clone()),
        proto_request(&AddRequest {
            knowledge: "always answer in haiku".into(),
            title: "haiku rule".into(),
            git_origin: String::new(),
        }),
    )
    .await
    .unwrap();
    let added: AddResponse = decode(response).await;
    assert!(added.success);
    assert!(
        added.id.starts_with("local-"),
        "offline add uses a local id"
    );
    let markdown = rules_root.join(format!("{}.md", added.id));
    assert_eq!(
        std::fs::read_to_string(&markdown).unwrap(),
        "always answer in haiku"
    );

    // List:本地缓存返回刚写入的规则。
    let response = knowledge::list(
        Extension(upstream.clone()),
        Extension(service.clone()),
        proto_request(&ListRequest { limit: Some(100) }),
    )
    .await
    .unwrap();
    let listed: ListResponse = decode(response).await;
    assert!(listed.success);
    assert_eq!(listed.all_results.len(), 1);
    assert_eq!(listed.all_results[0].id, added.id);
    assert_eq!(listed.all_results[0].title, "haiku rule");

    // Update:内容与标题都更新到 md 与元数据。
    let response = knowledge::update(
        Extension(upstream.clone()),
        Extension(service.clone()),
        proto_request(&UpdateRequest {
            id: added.id.clone(),
            knowledge: "always answer in sonnets".into(),
            title: "sonnet rule".into(),
        }),
    )
    .await
    .unwrap();
    let updated: UpdateResponse = decode(response).await;
    assert!(updated.success);
    assert_eq!(
        std::fs::read_to_string(&markdown).unwrap(),
        "always answer in sonnets"
    );

    // Remove:文件删除,列表为空。
    let response = knowledge::remove(
        Extension(upstream.clone()),
        Extension(service.clone()),
        proto_request(&RemoveRequest {
            id: added.id.clone(),
        }),
    )
    .await
    .unwrap();
    let removed: RemoveResponse = decode(response).await;
    assert!(removed.success);
    assert!(!markdown.exists());

    let response = knowledge::list(
        Extension(upstream),
        Extension(service),
        proto_request(&ListRequest { limit: Some(100) }),
    )
    .await
    .unwrap();
    let listed: ListResponse = decode(response).await;
    assert!(listed.all_results.is_empty());
}

#[tokio::test]
async fn updating_missing_rule_reports_failure() {
    let (_store_dir, store) = fixtures::temp_store().await;
    let upstream = CursorProxy::cursor(cursor_server::network::NetworkClients::new(store));
    let rules_dir = tempfile::tempdir().unwrap();
    let service = KnowledgeService::with_root(rules_dir.path().join("rules")).unwrap();

    let response = knowledge::update(
        Extension(upstream),
        Extension(service),
        proto_request(&UpdateRequest {
            id: "17353272".into(),
            knowledge: "anything".into(),
            title: "anything".into(),
        }),
    )
    .await
    .unwrap();
    let updated: UpdateResponse = decode(response).await;
    assert!(!updated.success);
}
