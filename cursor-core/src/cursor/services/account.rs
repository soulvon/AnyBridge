//! Implements Cursor account information services.
use axum::{
    body::{to_bytes, Body},
    extract::Extension,
    http::{header, HeaderValue, Request, Response},
};
use prost::Message;
use serde_json::Value;

use crate::{api::cursor::proxy, local_app, Result};

use super::entitlement::FreeEntitlementCache;

const LOCAL_AUTH_ID: &str = "cursor-local-user";
const LOCAL_EMAIL: &str = "cursor@ai.com";
const LOCAL_ULTRA_PLAN_INCLUDED_CENTS: i32 = 20_000;

#[derive(Clone, PartialEq, Message)]
struct GetEmailResponse {
    #[prost(string, tag = "1")]
    email: String,
    #[prost(int32, tag = "2")]
    sign_up_type: i32,
}

#[derive(Clone, PartialEq, Message)]
struct GetUserMetaResponse {
    #[prost(string, tag = "1")]
    email: String,
    #[prost(int32, tag = "2")]
    sign_up_type: i32,
    #[prost(int64, tag = "3")]
    user_id: i64,
    #[prost(string, optional, tag = "4")]
    workos_id: Option<String>,
    #[prost(string, optional, tag = "5")]
    profile_picture_url: Option<String>,
}

#[derive(Clone, PartialEq, Message)]
struct GetMeResponse {
    #[prost(string, tag = "1")]
    auth_id: String,
    #[prost(int32, tag = "2")]
    user_id: i32,
    #[prost(string, optional, tag = "3")]
    email: Option<String>,
    #[prost(string, optional, tag = "4")]
    first_name: Option<String>,
    #[prost(string, optional, tag = "5")]
    last_name: Option<String>,
    #[prost(string, optional, tag = "8")]
    created_at: Option<String>,
    #[prost(bool, optional, tag = "9")]
    is_enterprise_user: Option<bool>,
    #[prost(string, optional, tag = "11")]
    email_domain_type: Option<String>,
    #[prost(string, optional, tag = "12")]
    country: Option<String>,
    #[prost(string, optional, tag = "13")]
    profile_picture_url: Option<String>,
}

#[derive(Clone, PartialEq, Message)]
struct GetUserProfileResponse {
    #[prost(bool, optional, tag = "4")]
    public_visibility_allowed: Option<bool>,
    #[prost(string, optional, tag = "5")]
    max_visibility: Option<String>,
}

#[derive(Clone, PartialEq, Message)]
struct GetCurrentPeriodUsageResponse {
    #[prost(int64, tag = "1")]
    billing_cycle_start: i64,
    #[prost(int64, tag = "2")]
    billing_cycle_end: i64,
    #[prost(message, optional, tag = "3")]
    plan_usage: Option<PlanUsage>,
    #[prost(message, optional, tag = "4")]
    spend_limit_usage: Option<SpendLimitUsage>,
    #[prost(int32, optional, tag = "5")]
    display_threshold: Option<i32>,
    #[prost(bool, tag = "6")]
    enabled: bool,
    #[prost(string, tag = "7")]
    display_message: String,
    #[prost(string, optional, tag = "11")]
    auto_model_selected_display_message: Option<String>,
    #[prost(string, optional, tag = "12")]
    named_model_selected_display_message: Option<String>,
}

#[derive(Clone, PartialEq, Message)]
struct PlanUsage {
    #[prost(int32, tag = "1")]
    total_spend: i32,
    #[prost(int32, tag = "2")]
    included_spend: i32,
    #[prost(int32, tag = "4")]
    remaining: i32,
    #[prost(int32, tag = "5")]
    limit: i32,
    #[prost(bool, optional, tag = "6")]
    remaining_bonus: Option<bool>,
    #[prost(string, optional, tag = "7")]
    bonus_tooltip: Option<String>,
    #[prost(int32, optional, tag = "8")]
    auto_spend: Option<i32>,
    #[prost(int32, optional, tag = "9")]
    api_spend: Option<i32>,
    #[prost(double, optional, tag = "12")]
    auto_percent_used: Option<f64>,
    #[prost(double, optional, tag = "13")]
    api_percent_used: Option<f64>,
    #[prost(double, optional, tag = "14")]
    total_percent_used: Option<f64>,
}

#[derive(Clone, PartialEq, Message)]
struct SpendLimitUsage {
    #[prost(string, tag = "8")]
    limit_type: String,
}

#[derive(Clone, PartialEq, Message)]
struct GetUsageLimitStatusAndActiveGrantsResponse {
    #[prost(message, optional, tag = "1")]
    usage_limit_policy_status: Option<UsageLimitPolicyStatus>,
}

#[derive(Clone, PartialEq, Message)]
struct UsageLimitPolicyStatus {
    #[prost(bool, tag = "1")]
    is_in_slow_pool: bool,
    #[prost(map = "string, string", tag = "5")]
    features: std::collections::HashMap<String, String>,
    #[prost(bool, tag = "6")]
    can_configure_spend_limit: bool,
    #[prost(bool, tag = "8")]
    has_pending_request: bool,
    #[prost(string, repeated, tag = "9")]
    allowed_model_ids: Vec<String>,
    #[prost(string, repeated, tag = "10")]
    allowed_model_tags: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Message)]
struct Empty {}

pub async fn get_email(
    Extension(upstream): Extension<proxy::CursorProxy>,
    request: Request<Body>,
) -> Result<Response<Body>> {
    local_or_forward(upstream, request, || {
        proto(GetEmailResponse {
            email: LOCAL_EMAIL.into(),
            sign_up_type: 3,
        })
    })
    .await
}

pub async fn get_user_meta(
    Extension(upstream): Extension<proxy::CursorProxy>,
    request: Request<Body>,
) -> Result<Response<Body>> {
    local_or_forward(upstream, request, || {
        proto(GetUserMetaResponse {
            email: LOCAL_EMAIL.into(),
            sign_up_type: 3,
            user_id: 1,
            workos_id: None,
            profile_picture_url: None,
        })
    })
    .await
}

pub async fn get_me(
    Extension(upstream): Extension<proxy::CursorProxy>,
    request: Request<Body>,
) -> Result<Response<Body>> {
    local_or_forward(upstream, request, || {
        proto(GetMeResponse {
            auth_id: LOCAL_AUTH_ID.into(),
            user_id: 1,
            email: Some(LOCAL_EMAIL.into()),
            first_name: Some("Cursor".into()),
            last_name: Some("Local".into()),
            created_at: Some(chrono::Utc::now().to_rfc3339()),
            is_enterprise_user: Some(false),
            email_domain_type: Some("personal".into()),
            country: Some("US".into()),
            profile_picture_url: None,
        })
    })
    .await
}

pub async fn get_teams(
    Extension(upstream): Extension<proxy::CursorProxy>,
    request: Request<Body>,
) -> Result<Response<Body>> {
    local_or_forward(upstream, request, || proto(Empty {})).await
}

pub async fn get_user_profile(
    Extension(upstream): Extension<proxy::CursorProxy>,
    request: Request<Body>,
) -> Result<Response<Body>> {
    local_or_forward(upstream, request, || {
        proto(GetUserProfileResponse {
            public_visibility_allowed: Some(true),
            max_visibility: Some("PUBLIC".into()),
        })
    })
    .await
}

pub async fn current_period_usage(
    Extension(upstream): Extension<proxy::CursorProxy>,
    Extension(free_entitlements): Extension<FreeEntitlementCache>,
    request: Request<Body>,
) -> Result<Response<Body>> {
    local_or_confirmed_free_or_forward(upstream, &free_entitlements, request, || {
        let now = chrono::Utc::now();
        proto(GetCurrentPeriodUsageResponse {
            billing_cycle_start: (now - chrono::Duration::days(30)).timestamp_millis(),
            billing_cycle_end: (now + chrono::Duration::days(10 * 365)).timestamp_millis(),
            plan_usage: Some(PlanUsage {
                total_spend: 0,
                included_spend: LOCAL_ULTRA_PLAN_INCLUDED_CENTS,
                remaining: LOCAL_ULTRA_PLAN_INCLUDED_CENTS,
                limit: LOCAL_ULTRA_PLAN_INCLUDED_CENTS,
                remaining_bonus: Some(false),
                bonus_tooltip: Some("Ultra local account mock is active.".into()),
                auto_spend: Some(0),
                api_spend: Some(0),
                auto_percent_used: Some(0.0),
                api_percent_used: Some(0.0),
                total_percent_used: Some(0.0),
            }),
            spend_limit_usage: Some(SpendLimitUsage {
                limit_type: "user".into(),
            }),
            display_threshold: Some(99_999_999),
            enabled: true,
            display_message: "Ultra plan active".into(),
            auto_model_selected_display_message: Some("Ultra plan active".into()),
            named_model_selected_display_message: Some("Ultra plan active".into()),
        })
    })
    .await
}

pub async fn usage_limit_status(
    Extension(upstream): Extension<proxy::CursorProxy>,
    Extension(free_entitlements): Extension<FreeEntitlementCache>,
    request: Request<Body>,
) -> Result<Response<Body>> {
    local_or_confirmed_free_or_forward(upstream, &free_entitlements, request, || {
        proto(GetUsageLimitStatusAndActiveGrantsResponse {
            usage_limit_policy_status: Some(UsageLimitPolicyStatus {
                is_in_slow_pool: false,
                features: Default::default(),
                can_configure_spend_limit: true,
                has_pending_request: false,
                allowed_model_ids: Vec::new(),
                allowed_model_tags: Vec::new(),
            }),
        })
    })
    .await
}

pub async fn stripe_profile(
    Extension(upstream): Extension<proxy::CursorProxy>,
    Extension(free_entitlements): Extension<FreeEntitlementCache>,
    request: Request<Body>,
) -> Result<Response<Body>> {
    if local_app::request_uses_local_cursor_token(request.headers()) {
        return local_stripe_profile(request.headers().get(header::ORIGIN).cloned());
    }

    let request_headers = request.headers().clone();
    let origin = request.headers().get(header::ORIGIN).cloned();
    let upstream_response = match proxy::forward_buffered(&upstream, request).await {
        Ok(response) => response,
        Err(error) if free_entitlements.is_confirmed_free(&request_headers) => {
            tracing::warn!(%error, "using cached Free entitlement after Stripe upstream failure");
            return local_stripe_profile(origin);
        }
        Err(error) => return Err(error),
    };
    if !upstream_response.status.is_success() {
        if should_fallback_to_cached_free(
            upstream_response.status,
            &free_entitlements,
            &request_headers,
        ) {
            tracing::warn!(
                status = %upstream_response.status,
                "using cached Free entitlement after Stripe upstream failure"
            );
            return local_stripe_profile(origin);
        }
        return Ok(upstream_response.into_response());
    }

    let Some(membership_type) = membership_type(&upstream_response.body) else {
        return Ok(upstream_response.into_response());
    };
    let observed = free_entitlements.observe_membership(&request_headers, &membership_type);
    if observed && membership_type.eq_ignore_ascii_case("free") {
        return local_stripe_profile(origin);
    }

    Ok(upstream_response.into_response())
}

fn should_fallback_to_cached_free(
    status: axum::http::StatusCode,
    free_entitlements: &FreeEntitlementCache,
    headers: &axum::http::HeaderMap,
) -> bool {
    status.is_server_error() && free_entitlements.is_confirmed_free(headers)
}

fn membership_type(body: &[u8]) -> Option<String> {
    let profile: Value = serde_json::from_slice(body).ok()?;
    let membership_type = profile.get("membershipType")?.as_str()?.trim();
    (!membership_type.is_empty()).then(|| membership_type.to_owned())
}

fn local_stripe_profile(origin: Option<HeaderValue>) -> Result<Response<Body>> {
    let mut response = json(ultra_profile())?;
    if let Some(origin) = origin {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
            HeaderValue::from_static("true"),
        );
        response
            .headers_mut()
            .insert(header::VARY, HeaderValue::from_static("Origin"));
    }
    Ok(response)
}

async fn local_or_confirmed_free_or_forward(
    upstream: proxy::CursorProxy,
    free_entitlements: &FreeEntitlementCache,
    request: Request<Body>,
    local: impl FnOnce() -> Result<Response<Body>>,
) -> Result<Response<Body>> {
    if local_app::request_uses_local_cursor_token(request.headers())
        || free_entitlements.is_confirmed_free(request.headers())
    {
        consume_body(request).await?;
        return local();
    }
    proxy::forward(Extension(upstream), request).await
}

async fn local_or_forward(
    upstream: proxy::CursorProxy,
    request: Request<Body>,
    local: impl FnOnce() -> Result<Response<Body>>,
) -> Result<Response<Body>> {
    if local_app::request_uses_local_cursor_token(request.headers()) {
        consume_body(request).await?;
        return local();
    }
    proxy::forward(Extension(upstream), request).await
}

async fn consume_body(request: Request<Body>) -> Result<()> {
    to_bytes(request.into_body(), usize::MAX)
        .await
        .map_err(|error| crate::Error::Protocol(format!("cannot read request body: {error}")))?;
    Ok(())
}

fn proto(message: impl Message) -> Result<Response<Body>> {
    response("application/proto", message.encode_to_vec())
}

fn json(value: Value) -> Result<Response<Body>> {
    response("application/json", serde_json::to_vec(&value)?)
}

fn response(content_type: &'static str, body: Vec<u8>) -> Result<Response<Body>> {
    let length = body.len();
    let mut response = Response::new(Body::from(body));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static(content_type),
    );
    response.headers_mut().insert(
        header::CONTENT_LENGTH,
        length
            .to_string()
            .parse()
            .expect("body length is always a valid header value"),
    );
    Ok(response)
}

fn ultra_profile() -> Value {
    serde_json::json!({
        "membershipType": "ultra",
        "individualMembershipType": "ultra",
        "subscriptionStatus": "active",
        "lastPaymentFailed": false,
        "pendingCancellationDate": null,
        "daysRemainingOnTrial": 0,
        "paymentId": LOCAL_AUTH_ID,
        "isTeamMember": false
    })
}
