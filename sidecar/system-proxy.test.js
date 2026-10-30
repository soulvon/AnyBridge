import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { httpsAgentFor, _setProxyHealthForTest } from './system-proxy.js';

// 2026-10-30 事故：FlClash 退出后系统代理注册表残留 ProxyEnable=1 → 127.0.0.1:7897，
// 端口已无进程监听，sidecar 若继续按该地址建 agent，上游请求全部
// proxyconnect ECONNREFUSED。健康探测置为不可用后必须降级直连。
//
// 用固定注入地址（127.0.0.1:9，discard 端口，任何机器都无监听）：
// 此前不注入地址，测试结果依赖宿主机是否配置了系统代理——CI 的
// ubuntu/windows 没有，`代理恢复`用例两平台必挂（2026-10-31 实测）。

const FAKE_PROXY = 'http://127.0.0.1:9';

test('proxy health degraded → httpsAgentFor falls back to direct agent', () => {
  _setProxyHealthForTest(false, FAKE_PROXY);
  const direct = new https.Agent({ keepAlive: false });
  const agent = httpsAgentFor(direct);
  assert.equal(agent, direct, '代理不可用时应原样返回直连 agent');
});

test('proxy health restored → httpsAgentFor returns a proxy agent again', () => {
  _setProxyHealthForTest(true, FAKE_PROXY);
  const direct = new https.Agent({ keepAlive: false });
  const agent = httpsAgentFor(direct);
  assert.notEqual(agent, direct, '代理恢复后应返回经系统代理的 agent');
  assert.equal(agent.proxy.href, 'http://127.0.0.1:9/', '恢复后必须使用注入的代理地址');
});
