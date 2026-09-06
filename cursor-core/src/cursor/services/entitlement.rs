//! Caches a recently confirmed official Cursor Free entitlement.
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use axum::http::{header, HeaderMap};
use parking_lot::Mutex;
use sha2::{Digest, Sha256};

use crate::local_app;

const FREE_ENTITLEMENT_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Default)]
pub struct FreeEntitlementCache {
    cached: Arc<Mutex<Option<CachedFreeEntitlement>>>,
}

struct CachedFreeEntitlement {
    token_hash: [u8; 32],
    expires_at: Instant,
}

impl FreeEntitlementCache {
    pub fn is_confirmed_free(&self, headers: &HeaderMap) -> bool {
        let Some(token_hash) = official_token_hash(headers) else {
            return false;
        };
        let now = Instant::now();
        let mut cached = self.cached.lock();
        match cached.as_ref() {
            Some(entry) if entry.expires_at > now && entry.token_hash == token_hash => true,
            Some(entry) if entry.expires_at <= now => {
                *cached = None;
                false
            }
            _ => false,
        }
    }

    pub fn observe_membership(&self, headers: &HeaderMap, membership_type: &str) -> bool {
        let Some(token_hash) = official_token_hash(headers) else {
            return false;
        };
        let mut cached = self.cached.lock();
        if membership_type.eq_ignore_ascii_case("free") {
            *cached = Some(CachedFreeEntitlement {
                token_hash,
                expires_at: Instant::now() + FREE_ENTITLEMENT_TTL,
            });
        } else if cached
            .as_ref()
            .is_some_and(|entry| entry.token_hash == token_hash)
        {
            *cached = None;
        }
        true
    }
}

fn official_token_hash(headers: &HeaderMap) -> Option<[u8; 32]> {
    if local_app::request_uses_local_cursor_token(headers) {
        return None;
    }
    let token = headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")?;
    if token.is_empty() {
        return None;
    }
    Some(Sha256::digest(token.as_bytes()).into())
}
