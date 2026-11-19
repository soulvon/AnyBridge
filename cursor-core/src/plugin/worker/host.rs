use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

use super::{InvocationState, StreamLines, MAX_NETWORK_RESPONSE_BYTES, MAX_STREAM_BYTES};
use crate::{provider::CallRecorder, store::Store, Error, Result};

#[derive(Clone)]
pub(super) struct HostContext {
    pub(super) plugin_id: String,
    pub(super) network_hosts: Arc<HashSet<String>>,
    pub(super) store: Store,
    pub(super) invocations: Arc<Mutex<HashMap<String, Arc<InvocationState>>>>,
    pub(super) streams: Arc<Mutex<HashMap<String, StreamLines>>>,
}

pub(super) fn recorded_network_request(
    params: &serde_json::Value,
) -> Result<(serde_json::Value, serde_json::Value)> {
    let mut recorded_headers = serde_json::Map::new();
    if let Some(headers) = params.get("headers").and_then(serde_json::Value::as_object) {
        for (name, value) in headers {
            let value = value.as_str().ok_or_else(|| {
                Error::Config(format!("plugin HTTP header '{name}' must be a string"))
            })?;
            if !crate::model::is_sensitive_header(name) {
                recorded_headers.insert(name.clone(), value.into());
            }
        }
    }
    let body = params
        .get("body")
        .and_then(serde_json::Value::as_str)
        .map(|body| serde_json::from_str(body).unwrap_or_else(|_| body.into()))
        .unwrap_or(serde_json::Value::Null);
    Ok((serde_json::Value::Object(recorded_headers), body))
}

impl HostContext {
    pub(super) async fn call(
        &self,
        request_id: &str,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value> {
        match method {
            "network.fetch" => self.fetch(request_id, params).await,
            "network.stream.open" => self.stream_open(request_id, params).await,
            "network.stream.read" => self.stream_read(params).await,
            "network.stream.close" => {
                self.streams
                    .lock()
                    .await
                    .remove(required_string(&params, "streamId")?);
                Ok(serde_json::Value::Null)
            }
            _ => Err(Error::Protocol(format!(
                "unsupported plugin host method: {method}"
            ))),
        }
    }

    pub(super) async fn request(
        &self,
        request_id: &str,
        params: &serde_json::Value,
    ) -> Result<(
        reqwest::RequestBuilder,
        CancellationToken,
        Option<CallRecorder>,
    )> {
        let raw_url = required_string(params, "url")?;
        let url = url::Url::parse(raw_url)
            .map_err(|error| Error::Config(format!("invalid plugin network URL: {error}")))?;
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
            return Err(Error::Config(
                "plugin network URL must be HTTPS without credentials".into(),
            ));
        }
        let host = url
            .host_str()
            .ok_or_else(|| Error::Config("plugin network URL has no host".into()))?
            .to_ascii_lowercase();
        if !self.network_hosts.contains(&host) {
            return Err(Error::Config(format!(
                "plugin '{}' cannot access host '{host}'",
                self.plugin_id
            )));
        }
        let method = params
            .get("method")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("GET")
            .parse::<reqwest::Method>()
            .map_err(|error| Error::Config(format!("invalid plugin HTTP method: {error}")))?;
        let client = crate::network::client_builder(&self.store)
            .await?
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(30))
            .build()?;
        let mut request = client.request(method, url);
        if let Some(headers) = params.get("headers").and_then(serde_json::Value::as_object) {
            for (name, value) in headers {
                let value = value.as_str().ok_or_else(|| {
                    Error::Config(format!("plugin HTTP header '{name}' must be a string"))
                })?;
                request = request.header(name, value);
            }
        }
        if let Some(body) = params.get("body").and_then(serde_json::Value::as_str) {
            request = request.body(body.to_owned());
        }
        let invocation = self.invocations.lock().await.get(request_id).cloned();
        let cancellation = invocation
            .as_ref()
            .map(|state| state.cancellation.clone())
            .unwrap_or_default();
        let recorder = invocation.and_then(|state| state.claim_recorder());
        if let Some(recorder) = &recorder {
            let (headers, body) = recorded_network_request(params)?;
            recorder.request(headers, &body).await?;
        }
        Ok((request, cancellation, recorder))
    }

    async fn fetch(
        &self,
        request_id: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let (request, cancellation, recorder) = self.request(request_id, &params).await?;
        let request = request.timeout(Duration::from_secs(60));
        let response = tokio::select! {
            _ = cancellation.cancelled() => return Err(Error::Cancelled),
            response = request.send() => response?,
        };
        let status = response.status().as_u16();
        if let Some(recorder) = &recorder {
            recorder.response_headers(status).await?;
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_NETWORK_RESPONSE_BYTES)
        {
            return Err(Error::Provider(
                "plugin network response is larger than allowed".into(),
            ));
        }
        let headers = header_map(&response);
        let body = tokio::select! {
            _ = cancellation.cancelled() => return Err(Error::Cancelled),
            body = response.bytes() => body?,
        };
        if body.len() as u64 > MAX_NETWORK_RESPONSE_BYTES {
            return Err(Error::Provider(
                "plugin network response is larger than allowed".into(),
            ));
        }
        if let Some(recorder) = &recorder {
            recorder.response_chunk(&body).await?;
        }
        Ok(
            serde_json::json!({ "status": status, "headers": headers, "body": String::from_utf8_lossy(&body) }),
        )
    }

    /// 打开流式响应:立即返回状态与响应头,响应体按行经 stream.read 拉取。
    async fn stream_open(
        &self,
        request_id: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let (request, cancellation, recorder) = self.request(request_id, &params).await?;
        let response = tokio::select! {
            _ = cancellation.cancelled() => return Err(Error::Cancelled),
            response = request.send() => response?,
        };
        let status = response.status().as_u16();
        if let Some(recorder) = &recorder {
            recorder.response_headers(status).await?;
        }
        let headers = header_map(&response);
        let (sender, receiver) = mpsc::channel::<Result<String>>(256);
        tokio::spawn(async move {
            use futures_util::StreamExt;
            let mut body = response.bytes_stream();
            let mut buffered = Vec::<u8>::new();
            let mut total = 0_u64;
            loop {
                let chunk = tokio::select! {
                    _ = cancellation.cancelled() => {
                        let _ = sender.send(Err(Error::Cancelled)).await;
                        return;
                    }
                    chunk = body.next() => chunk,
                };
                let Some(chunk) = chunk else { break };
                let chunk = match chunk {
                    Ok(chunk) => chunk,
                    Err(error) => {
                        let _ = sender.send(Err(Error::from(error))).await;
                        return;
                    }
                };
                total += chunk.len() as u64;
                if total > MAX_STREAM_BYTES {
                    let _ = sender
                        .send(Err(Error::Provider(
                            "plugin network stream is larger than allowed".into(),
                        )))
                        .await;
                    return;
                }
                if let Some(recorder) = &recorder {
                    if let Err(error) = recorder.response_chunk(&chunk).await {
                        let _ = sender.send(Err(error)).await;
                        return;
                    }
                }
                buffered.extend_from_slice(&chunk);
                while let Some(position) = buffered.iter().position(|byte| *byte == b'\n') {
                    let mut line = buffered.drain(..=position).collect::<Vec<u8>>();
                    line.pop();
                    if line.last() == Some(&b'\r') {
                        line.pop();
                    }
                    if sender
                        .send(Ok(String::from_utf8_lossy(&line).into_owned()))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            }
            if !buffered.is_empty() {
                let _ = sender
                    .send(Ok(String::from_utf8_lossy(&buffered).into_owned()))
                    .await;
            }
        });
        let stream_id = uuid::Uuid::new_v4().to_string();
        self.streams
            .lock()
            .await
            .insert(stream_id.clone(), Arc::new(Mutex::new(receiver)));
        Ok(serde_json::json!({
            "streamId": stream_id,
            "status": status,
            "headers": headers,
        }))
    }

    async fn stream_read(&self, params: serde_json::Value) -> Result<serde_json::Value> {
        let stream_id = required_string(&params, "streamId")?;
        let lines_handle = self
            .streams
            .lock()
            .await
            .get(stream_id)
            .cloned()
            .ok_or_else(|| Error::Protocol(format!("unknown plugin stream: {stream_id}")))?;
        let mut receiver = lines_handle.lock().await;
        let mut lines = Vec::new();
        match receiver.recv().await {
            Some(Ok(line)) => lines.push(line),
            Some(Err(error)) => {
                drop(receiver);
                self.streams.lock().await.remove(stream_id);
                return Err(error);
            }
            None => {
                drop(receiver);
                self.streams.lock().await.remove(stream_id);
                return Ok(serde_json::json!({ "lines": [], "done": true }));
            }
        }
        // 把已就绪的行一并带走,减少往返。
        while lines.len() < 256 {
            match receiver.try_recv() {
                Ok(Ok(line)) => lines.push(line),
                Ok(Err(error)) => {
                    drop(receiver);
                    self.streams.lock().await.remove(stream_id);
                    return Err(error);
                }
                Err(_) => break,
            }
        }
        Ok(serde_json::json!({ "lines": lines, "done": false }))
    }
}

fn header_map(response: &reqwest::Response) -> std::collections::BTreeMap<String, String> {
    response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.to_string(), value.to_string()))
        })
        .collect()
}

fn required_string<'a>(params: &'a serde_json::Value, key: &str) -> Result<&'a str> {
    params
        .get(key)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| Error::Protocol(format!("plugin host call requires string '{key}'")))
}
