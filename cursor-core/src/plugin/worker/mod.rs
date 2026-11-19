//! Runs one long-lived, sandboxed Deno process per active plugin.
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin},
    sync::{mpsc, Mutex},
};
use tokio_util::sync::CancellationToken;

use super::{
    catalog::PluginEntry,
    definition::{file_url, PluginDefinitionLoader},
    protocol::{HostMessage, WorkerMessage},
};
use crate::{provider::CallRecorder, store::Store, Error, Result};


mod host;
#[cfg(test)]
mod tests;

use host::HostContext;

const INVOCATION_TIMEOUT: Duration = Duration::from_secs(10 * 60);
pub(super) const MAX_NETWORK_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;
pub(super) const MAX_STREAM_BYTES: u64 = 256 * 1024 * 1024;

/// 一次流式调用的输出:零或多个事件,然后恰好一个最终结果。
#[derive(Debug)]
pub enum WorkerStreamItem {
    Event(serde_json::Value),
    Result(Result<serde_json::Value>),
}

type Pending = Arc<Mutex<HashMap<String, mpsc::UnboundedSender<WorkerStreamItem>>>>;
pub(super) type StreamLines = Arc<Mutex<mpsc::Receiver<Result<String>>>>;

#[derive(Clone)]

pub struct PluginWorker {
    inner: Arc<PluginWorkerInner>,
}

struct PluginWorkerInner {
    plugin_id: String,
    executable: PathBuf,
    directory: PathBuf,
    entry: PathBuf,
    loader: PluginDefinitionLoader,
    host: HostContext,
    process: Mutex<Option<WorkerProcess>>,
    pending: Pending,
}

struct WorkerProcess {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
}

pub(super) struct InvocationState {
    pub(super) cancellation: CancellationToken,
    pub(super) recorder: Option<CallRecorder>,
    pub(super) recorder_claimed: AtomicBool,
}

impl InvocationState {
    pub(super) fn claim_recorder(&self) -> Option<CallRecorder> {
        self.recorder.as_ref().and_then(|recorder| {
            self.recorder_claimed
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .ok()
                .map(|_| recorder.clone())
        })
    }
}


impl PluginWorker {
    pub fn new(
        plugin: &PluginEntry,
        executable: PathBuf,
        loader: PluginDefinitionLoader,
        store: Store,
    ) -> Self {
        let plugin_id = plugin.manifest.id.clone();
        Self {
            inner: Arc::new(PluginWorkerInner {
                host: HostContext {
                    plugin_id: plugin_id.clone(),
                    network_hosts: Arc::new(
                        plugin
                            .manifest
                            .permissions
                            .network
                            .iter()
                            .map(|host| host.to_ascii_lowercase())
                            .collect(),
                    ),
                    store,
                    invocations: Arc::new(Mutex::new(HashMap::new())),
                    streams: Arc::new(Mutex::new(HashMap::new())),
                },
                plugin_id,
                executable,
                directory: plugin.directory.clone(),
                entry: plugin.entry.clone(),
                loader,
                process: Mutex::new(None),
                pending: Arc::new(Mutex::new(HashMap::new())),
            }),
        }
    }

    /// 一元调用:忽略事件,等待最终结果,受统一超时约束。
    pub async fn invoke(
        &self,
        method: &str,
        params: serde_json::Value,
        cancellation: CancellationToken,
    ) -> Result<serde_json::Value> {
        let mut items = self
            .invoke_streaming(method, params, cancellation, None)
            .await?;
        let result = tokio::time::timeout(INVOCATION_TIMEOUT, async {
            while let Some(item) = items.recv().await {
                if let WorkerStreamItem::Result(result) = item {
                    return result;
                }
            }
            Err(Error::Provider(format!(
                "plugin '{}' worker stopped",
                self.inner.plugin_id
            )))
        })
        .await;
        match result {
            Ok(result) => result,
            Err(_) => Err(Error::Provider(format!(
                "plugin '{}' invocation timed out",
                self.inner.plugin_id
            ))),
        }
    }

    /// 流式调用:事件按序转发,最终以恰好一个 Result 收尾。
    /// 取消通过传入的令牌传播到 Worker 与其挂起的宿主网络请求。
    pub async fn invoke_streaming(
        &self,
        method: &str,
        params: serde_json::Value,
        cancellation: CancellationToken,
        recorder: Option<CallRecorder>,
    ) -> Result<mpsc::UnboundedReceiver<WorkerStreamItem>> {
        let id = uuid::Uuid::new_v4().to_string();
        let request_cancellation = CancellationToken::new();
        self.inner.host.invocations.lock().await.insert(
            id.clone(),
            Arc::new(InvocationState {
                cancellation: request_cancellation.clone(),
                recorder,
                recorder_claimed: AtomicBool::new(false),
            }),
        );
        let (sender, receiver) = mpsc::unbounded_channel();
        self.inner
            .pending
            .lock()
            .await
            .insert(id.clone(), sender.clone());
        let send_result = async {
            let stdin = self.stdin().await?;
            write_message(
                &stdin,
                &HostMessage::Request {
                    id: &id,
                    method,
                    params: &params,
                },
            )
            .await
        }
        .await;
        if let Err(error) = send_result {
            self.cleanup(&id).await;
            return Err(error);
        }

        // 取消监视:通知 Worker,同时中止该请求挂起的宿主网络调用。
        let inner = self.inner.clone();
        let request_id = id.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = cancellation.cancelled() => {
                    request_cancellation.cancel();
                    if let Some(process) = inner.process.lock().await.as_ref() {
                        let _ = write_message(&process.stdin, &HostMessage::Cancel { id: &request_id }).await;
                    }
                    let _ = sender.send(WorkerStreamItem::Result(Err(Error::Cancelled)));
                    inner.pending.lock().await.remove(&request_id);
                    inner.host.invocations.lock().await.remove(&request_id);
                }
                _ = sender.closed() => {
                    inner.host.invocations.lock().await.remove(&request_id);
                }
            }
        });
        Ok(receiver)
    }

    pub async fn stop(&self) {
        if let Some(mut process) = self.inner.process.lock().await.take() {
            let _ = process.child.kill().await;
        }
        fail_pending(&self.inner.pending, "plugin worker stopped").await;
    }

    async fn cleanup(&self, id: &str) {
        self.inner.pending.lock().await.remove(id);
        self.inner.host.invocations.lock().await.remove(id);
    }

    async fn stdin(&self) -> Result<Arc<Mutex<ChildStdin>>> {
        let mut process = self.inner.process.lock().await;
        let dead = match process.as_mut() {
            Some(current) => current
                .child
                .try_wait()
                .map_err(|error| {
                    Error::Config(format!("cannot check plugin worker status: {error}"))
                })?
                .is_some(),
            None => true,
        };
        if dead {
            *process = Some(self.spawn().await?);
        }
        Ok(process
            .as_ref()
            .expect("plugin worker was started")
            .stdin
            .clone())
    }

    async fn spawn(&self) -> Result<WorkerProcess> {
        let entry_url = file_url(&self.inner.entry)?;
        let mut command = tokio::process::Command::new(&self.inner.executable);
        super::detach_console(&mut command);
        command
            .arg("run")
            .arg("--quiet")
            .arg("--no-config")
            .arg("--no-lock")
            .arg("--no-npm")
            .arg("--no-remote")
            .arg("--no-prompt")
            .arg(format!("--allow-read={}", self.inner.directory.display()))
            .arg(format!(
                "--allow-read={}",
                self.inner.loader.sdk_dir().display()
            ))
            .arg(format!(
                "--import-map={}",
                self.inner.loader.import_map().display()
            ))
            .arg(self.inner.loader.worker_path())
            .arg(entry_url.as_str())
            .env("DENO_DIR", self.inner.loader.deno_dir())
            .env("DENO_NO_UPDATE_CHECK", "1")
            .current_dir(&self.inner.directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|error| {
            Error::Config(format!(
                "cannot start plugin worker {}: {error}",
                self.inner.executable.display()
            ))
        })?;
        let stdin =
            Arc::new(Mutex::new(child.stdin.take().ok_or_else(|| {
                Error::Config("cannot open plugin worker stdin".into())
            })?));
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::Config("cannot open plugin worker stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| Error::Config("cannot open plugin worker stderr".into()))?;
        spawn_stdout_reader(
            self.inner.plugin_id.clone(),
            stdout,
            stdin.clone(),
            self.inner.pending.clone(),
            self.inner.host.clone(),
        );
        spawn_stderr_reader(self.inner.plugin_id.clone(), stderr);
        Ok(WorkerProcess { child, stdin })
    }
}

fn spawn_stdout_reader(
    plugin_id: String,
    stdout: tokio::process::ChildStdout,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Pending,
    host: HostContext,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let message = match serde_json::from_str::<WorkerMessage>(&line) {
                Ok(message) => message,
                Err(error) => {
                    tracing::warn!(plugin = %plugin_id, %error, "plugin worker wrote an invalid message");
                    continue;
                }
            };
            match message {
                WorkerMessage::Result { id, result, error } => {
                    if let Some(sender) = pending.lock().await.remove(&id) {
                        let value = match error {
                            Some(error) => {
                                Err(Error::Provider(format!("plugin '{plugin_id}': {error}")))
                            }
                            None => Ok(result),
                        };
                        let _ = sender.send(WorkerStreamItem::Result(value));
                    }
                }
                WorkerMessage::Event { id, event } => {
                    if let Some(sender) = pending.lock().await.get(&id) {
                        let _ = sender.send(WorkerStreamItem::Event(event));
                    }
                }
                WorkerMessage::HostCall {
                    id,
                    request_id,
                    method,
                    params,
                } => {
                    let host = host.clone();
                    let stdin = stdin.clone();
                    tokio::spawn(async move {
                        let result = host.call(&request_id, &method, params).await;
                        match result {
                            Ok(result) => {
                                let _ = write_message(
                                    &stdin,
                                    &HostMessage::HostResult {
                                        id: &id,
                                        result: &result,
                                    },
                                )
                                .await;
                            }
                            Err(error) => {
                                let text = error.to_string();
                                let _ = write_message(
                                    &stdin,
                                    &HostMessage::HostError {
                                        id: &id,
                                        error: &text,
                                    },
                                )
                                .await;
                            }
                        }
                    });
                }
            }
        }
        fail_pending(&pending, &format!("plugin '{plugin_id}' worker exited")).await;
    });
}

fn spawn_stderr_reader(plugin_id: String, stderr: tokio::process::ChildStderr) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::warn!(plugin = %plugin_id, message = %line, "plugin worker stderr");
        }
    });
}

async fn write_message(stdin: &Arc<Mutex<ChildStdin>>, message: &HostMessage<'_>) -> Result<()> {
    let mut bytes = serde_json::to_vec(message)?;
    bytes.push(b'\n');
    let mut stdin = stdin.lock().await;
    stdin
        .write_all(&bytes)
        .await
        .map_err(|error| Error::Config(format!("cannot write to plugin worker: {error}")))?;
    stdin
        .flush()
        .await
        .map_err(|error| Error::Config(format!("cannot flush plugin worker stdin: {error}")))?;
    Ok(())
}

async fn fail_pending(pending: &Pending, message: &str) {
    for (_, sender) in std::mem::take(&mut *pending.lock().await) {
        let _ = sender.send(WorkerStreamItem::Result(Err(Error::Provider(
            message.into(),
        ))));
    }
}
