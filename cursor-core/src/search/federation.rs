//! Aggregates and ranks results from search sources.
use std::{cmp::Ordering, collections::HashMap};

use futures_util::future::join_all;

use crate::store::Store;

use super::{catalog, SearchEngine, SearchHit};

const RRF_K: f64 = 60.0;
const MAX_RESULTS: usize = 15;

#[derive(Clone)]
pub struct WebSearch {
    client: SearchClient,
    engines: Vec<SearchEngine>,
}

#[derive(Clone)]
enum SearchClient {
    Managed(Store),
    Direct(reqwest::Client),
}

#[derive(Debug, thiserror::Error)]
#[error("web search failed: {0}")]
pub struct SearchError(String);

impl WebSearch {
    pub fn built_in() -> Self {
        Self::with_engines(catalog::engines())
    }

    pub(crate) fn managed(store: Store) -> Self {
        Self {
            client: SearchClient::Managed(store),
            engines: catalog::engines(),
        }
    }

    pub fn with_engines<I, E>(engines: I) -> Self
    where
        I: IntoIterator<Item = E>,
        E: Into<SearchEngine>,
    {
        Self {
            client: SearchClient::Direct(reqwest::Client::new()),
            engines: engines.into_iter().map(Into::into).collect(),
        }
    }

    pub fn engine_ids(&self) -> Vec<&'static str> {
        self.engines.iter().map(SearchEngine::id).collect()
    }

    pub async fn search(&self, query: &str) -> Result<Vec<SearchHit>, SearchError> {
        let query = query.trim();
        if query.is_empty() {
            return Err(SearchError("query is empty".into()));
        }
        let client = match &self.client {
            SearchClient::Managed(store) => crate::network::client(store)
                .await
                .map_err(|error| SearchError(format!("HTTP client failed: {error}")))?,
            SearchClient::Direct(client) => client.clone(),
        };
        let responses = join_all(
            self.engines
                .iter()
                .map(|engine| engine.search(&client, query)),
        )
        .await;
        let mut merged = HashMap::<String, SearchHit>::new();
        let mut failures = Vec::new();
        for (engine, response) in self.engines.iter().zip(responses) {
            match response {
                Ok(results) if !results.is_empty() => {
                    tracing::debug!(
                        engine = engine.id(),
                        results = results.len(),
                        "search engine completed"
                    );
                    merge(&mut merged, engine.id(), results)
                }
                Ok(_) => {
                    tracing::debug!(engine = engine.id(), "search engine returned no results");
                    failures.push(engine.id().to_string());
                }
                Err(error) => {
                    tracing::warn!(engine = engine.id(), %error, "search engine failed");
                    failures.push(engine.id().to_string());
                }
            }
        }
        if merged.is_empty() {
            return Err(SearchError(format!(
                "no results from engines: {}",
                failures.join(", ")
            )));
        }
        let mut results = merged.into_values().collect::<Vec<_>>();
        results.sort_by(|left, right| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(Ordering::Equal)
                .then_with(|| left.url.cmp(&right.url))
        });
        results.truncate(MAX_RESULTS);
        Ok(results)
    }
}

impl Default for WebSearch {
    fn default() -> Self {
        Self::built_in()
    }
}

fn merge(merged: &mut HashMap<String, SearchHit>, engine: &'static str, results: Vec<SearchHit>) {
    for (rank, mut result) in results.into_iter().enumerate() {
        let score = 1.0 / (RRF_K + rank as f64 + 1.0);
        match merged.get_mut(&result.url) {
            Some(existing) => {
                existing.score += score;
                if !existing.engines.contains(&engine) {
                    existing.engines.push(engine);
                }
                if result.chunk.len() > existing.chunk.len() {
                    existing.chunk = result.chunk;
                }
            }
            None => {
                result.score = score;
                merged.insert(result.url.clone(), result);
            }
        }
    }
}
