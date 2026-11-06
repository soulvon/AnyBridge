// 插件 ↔ 供应商热插拔链路的持久判据：防止前后端事件名漂移、
// 或新增写盘时机时漏掉通知 / 漏掉对账（事故见 docs/pitfalls.json）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rust = fs.readFileSync(path.join(root, 'src-tauri/src/commands/plugins.rs'), 'utf8');
const init = fs.readFileSync(path.join(root, 'ui/assets/scripts/90-init.js'), 'utf8');

describe('插件供应商热插拔', () => {
  it('前后端使用同一个变更事件名', () => {
    assert.match(rust, /const PROVIDERS_CHANGED_EVENT: &str = "providers-changed";/);
    assert.match(init, /tauriEvent\.listen\('providers-changed'/);
  });

  it('登记/配置同步/启动对账收敛到同一个写入点', () => {
    const calls = (rust.match(/upsert_plugin_provider\(/g) || []).length;
    assert.ok(calls >= 3, `upsert 调用点只有 ${calls} 处，疑似又各写了一份`);
    assert.match(rust, /fn auto_add_plugin_provider/);
    assert.match(rust, /fn remove_plugin_provider/);
    assert.match(rust, /pub fn reconcile_plugin_providers/);
  });

  it('登记、移除、配置变更、模型同步、启动对账都通知前端', () => {
    const emits = (rust.match(/emit_providers_changed\(/g) || []).length;
    assert.ok(emits >= 6, `事件发射点只有 ${emits} 处（含函数定义），疑似漏通知`);
  });

  it('前端收到事件后重读快照，失败有明确反馈而不是静默吞掉', () => {
    assert.match(init, /providers-changed[\s\S]{0,400}loadProviders\(\)/);
    assert.match(init, /loadProviders\(\)\.catch\(\(e\) => addLog\('warn', String\(e\)\)\)/);
  });

  it('模型目录复用 fetch_models，不另写下载链路', () => {
    assert.match(rust, /config::fetch_models\(FetchModelsArgs/);
    assert.match(rust, /fn spawn_models_sync_when_ready/);
  });
});
