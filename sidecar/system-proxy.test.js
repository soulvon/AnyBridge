import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { httpsAgentFor, _setProxyHealthForTest } from './system-proxy.js';

// 2026-10-30 事故：FlClash 退出后系统代理注册表残留 ProxyEnable=1 → 127.0.0.1:7897，
// 端口已无进程监听，sidecar 若继续按该地址建 agent，上游请求全部
// proxyconnect ECONNREFUSED。健康探测置为不可用后必须降级直连。

test('proxy health degraded → httpsAgentFor falls back to direct agent', () => {
  _setProxyHealthForTest(false);
  const direct = new https.Agent({ keepAlive: false });
  const agent = httpsAgentFor(direct);
  assert.equal(agent, direct, '代理不可用时应原样返回直连 agent');
});

test('proxy health restored → httpsAgentFor returns a proxy agent again', () => {
  _setProxyHealthForTest(true);
  const direct = new https.Agent({ keepAlive: false });
  const agent = httpsAgentFor(direct);
  assert.notEqual(agent, direct, '代理恢复后应返回经系统代理的 agent');
});
