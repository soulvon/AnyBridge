//! Persists content-addressed blobs and their edges.
//! Storage accounting and cleanup for disposable observability data.

use serde::{Deserialize, Serialize};

use crate::Result;

use super::Store;

#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct StatisticsStorage {
    pub bytes: i64,
    pub call_count: i64,
    pub trace_count: i64,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum StatisticsStorageScope {
    #[default]
    Details,
    All,
}

impl Store {
    pub async fn statistics_storage(&self) -> Result<StatisticsStorage> {
        let (bytes, call_count, trace_count) = sqlx::query_as::<_, (i64, i64, i64)>(
            r#"
            SELECT
                COALESCE((
                    SELECT SUM(
                        LENGTH(call_id) + LENGTH(run_id) + LENGTH(conversation_id) +
                        LENGTH(provider_type) + LENGTH(provider_url) + LENGTH(request_type) +
                        LENGTH(request_url) + LENGTH(model_id) + LENGTH(display_name) +
                        LENGTH(status) + COALESCE(LENGTH(finish_reason), 0) +
                        COALESCE(LENGTH(usage_json), 0) + COALESCE(LENGTH(error_kind), 0) +
                        COALESCE(LENGTH(error_message), 0) + 256
                    ) FROM llm_calls
                ), 0) +
                COALESCE((SELECT SUM(LENGTH(headers_json) + LENGTH(body_json) + 24) FROM llm_call_requests), 0) +
                COALESCE((SELECT SUM(LENGTH(data) + 24) FROM llm_call_response_chunks), 0) +
                COALESCE((
                    SELECT SUM(
                        LENGTH(request_id) + COALESCE(LENGTH(conversation_id), 0) +
                        LENGTH(route) + COALESCE(LENGTH(model_id), 0) + LENGTH(status) +
                        COALESCE(LENGTH(error_message), 0) + 96
                    ) FROM cursor_run_traces
                ), 0) +
                COALESCE((SELECT SUM(LENGTH(artifact_type) + LENGTH(source) + LENGTH(metadata_json) + 48) FROM cursor_run_trace_artifacts), 0) +
                COALESCE((SELECT SUM(LENGTH(data)) FROM blobs WHERE blob_id IN (SELECT blob_id FROM cursor_run_trace_artifacts)), 0),
                (SELECT COUNT(*) FROM llm_calls),
                (SELECT COUNT(*) FROM cursor_run_traces)
            "#,
        )
        .fetch_one(&self.pool)
        .await?;

        Ok(StatisticsStorage {
            bytes,
            call_count,
            trace_count,
        })
    }

    pub async fn clear_statistics_storage(&self) -> Result<StatisticsStorage> {
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin().await?;
        Self::clear_detail_storage_tx(&mut transaction).await?;
        transaction.commit().await?;
        self.statistics_storage().await
    }

    pub async fn clear_all_statistics_storage(&self) -> Result<StatisticsStorage> {
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin().await?;
        Self::clear_trace_artifacts_tx(&mut transaction).await?;
        sqlx::query("DELETE FROM llm_calls")
            .execute(&mut *transaction)
            .await?;
        sqlx::query("DELETE FROM cursor_run_traces")
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        self.statistics_storage().await
    }

    async fn clear_detail_storage_tx(
        transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    ) -> Result<()> {
        sqlx::query("DELETE FROM llm_call_requests")
            .execute(&mut **transaction)
            .await?;
        sqlx::query("DELETE FROM llm_call_response_chunks")
            .execute(&mut **transaction)
            .await?;
        Self::clear_trace_artifacts_tx(transaction).await
    }

    async fn clear_trace_artifacts_tx(
        transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    ) -> Result<()> {
        sqlx::query(
            "CREATE TEMP TABLE IF NOT EXISTS clear_statistics_blob_ids(
                blob_id BLOB PRIMARY KEY
             )",
        )
        .execute(&mut **transaction)
        .await?;
        sqlx::query("DELETE FROM clear_statistics_blob_ids")
            .execute(&mut **transaction)
            .await?;
        sqlx::query(
            "INSERT OR IGNORE INTO clear_statistics_blob_ids(blob_id)
             SELECT blob_id FROM cursor_run_trace_artifacts",
        )
        .execute(&mut **transaction)
        .await?;
        sqlx::query("DELETE FROM cursor_run_trace_artifacts")
            .execute(&mut **transaction)
            .await?;
        sqlx::query(
            "DELETE FROM blobs
             WHERE blob_id IN (SELECT blob_id FROM clear_statistics_blob_ids)
               AND NOT EXISTS (
                   SELECT 1 FROM cursor_run_trace_artifacts a WHERE a.blob_id = blobs.blob_id
               )
               AND NOT EXISTS (
                   SELECT 1 FROM blob_edges e
                   WHERE e.parent_blob_id = blobs.blob_id OR e.child_blob_id = blobs.blob_id
               )",
        )
        .execute(&mut **transaction)
        .await?;
        sqlx::query("DROP TABLE clear_statistics_blob_ids")
            .execute(&mut **transaction)
            .await?;
        Ok(())
    }
}
