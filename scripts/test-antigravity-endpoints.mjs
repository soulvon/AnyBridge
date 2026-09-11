// test-antigravity-endpoints.mjs — 自动化全链路协议与端点健康测试
import http from 'node:http';

const PORT = 7450;
const BASE_URL = `http://127.0.0.1:${PORT}`;

function post(path, body = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const start = performance.now();
    const req = http.request(
      `${BASE_URL}${path}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 5000,
      },
      (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const elapsed = performance.now() - start;
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              data: JSON.parse(raw),
              elapsed,
            });
          } catch {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              raw,
              elapsed,
            });
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout connecting to ${path}`));
    });
    req.write(data);
    req.end();
  });
}

async function runTests() {
  console.log('========================================================');
  console.log('🚀 开始 Antigravity 本地网关协议与端点全矩阵体检');
  console.log(`📡 目标端点: ${BASE_URL}`);
  console.log('========================================================\n');

  let passed = 0;
  let failed = 0;

  async function check(name, fn) {
    try {
      await fn();
      console.log(`✅ [通过] ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ [失败] ${name}: ${err.message}`);
      failed++;
    }
  }

  // 1. fetchAvailableModels 模型列表
  await check('模型列表 fetchAvailableModels (结构、分组与默认模型)', async () => {
    const res = await post('/v1internal:fetchAvailableModels');
    if (res.status !== 200) throw new Error(`HTTP状态码异常: ${res.status}`);
    if (res.elapsed > 500) throw new Error(`响应超时，耗时 ${res.elapsed.toFixed(1)}ms`);
    const json = res.data;
    if (!json.models || typeof json.models !== 'object') throw new Error('缺少 models 字段');
    const modelKeys = Object.keys(json.models);
    if (modelKeys.length === 0) throw new Error('models 列表为空');

    const byokModels = Object.entries(json.models).filter(([k]) => k.startsWith('byok-'));
    if (byokModels.length === 0) throw new Error('未注入任何 BYOK 模型');

    for (const [key, details] of byokModels) {
      if (!details.model?.startsWith('MODEL_')) {
        throw new Error(`模型 ${key} 未使用合法的 MODEL_ 枚举槽位: ${details.model}`);
      }
      if (!details.displayName) throw new Error(`模型 ${key} 缺少 displayName`);
    }

    if (!Array.isArray(json.agentModelSorts) || json.agentModelSorts.length === 0) {
      throw new Error('agentModelSorts 为空，会导致 IDE 报 No models available！');
    }

    const firstGroup = json.agentModelSorts[0].groups?.[0];
    if (!firstGroup || !Array.isArray(firstGroup.modelIds) || firstGroup.modelIds.length === 0) {
      throw new Error('agentModelSorts 分组中 modelIds 为空');
    }

    if (!json.defaultAgentModelId) throw new Error('defaultAgentModelId 为空，会导致 No Model Selected！');
    if (!json.models[json.defaultAgentModelId]) {
      throw new Error(`defaultAgentModelId [${json.defaultAgentModelId}] 在 models 中不存在`);
    }

    console.log(`   - 发现可用模型数: ${modelKeys.length} 个（BYOK 注入: ${byokModels.length} 个）`);
    console.log(`   - 默认选中模型: ${json.defaultAgentModelId}`);
    console.log(`   - 响应耗时: ${res.elapsed.toFixed(1)}ms`);
  });

  // 2. loadCodeAssist
  await check('账号权限握手 loadCodeAssist', async () => {
    const res = await post('/v1internal:loadCodeAssist');
    if (res.status !== 200) throw new Error(`HTTP状态码异常: ${res.status}`);
    if (res.data.currentTier?.id !== 'standard-tier') throw new Error('currentTier 异常');
    if (res.data.cloudaicompanionProject !== '') throw new Error('cloudaicompanionProject 必须为空');
    console.log(`   - 状态: ${res.data.currentTier.name} | 响应耗时: ${res.elapsed.toFixed(1)}ms`);
  });

  // 3. onboardUser
  await check('用户引导状态 onboardUser', async () => {
    const res = await post('/v1internal:onboardUser', { tierId: 'free-tier' });
    if (res.status !== 200) throw new Error(`HTTP状态码异常: ${res.status}`);
    if (!res.data.done) throw new Error('onboardUser 必须返回 done: true');
    console.log(`   - 状态: ${res.data.response?.status?.statusCode} | 响应耗时: ${res.elapsed.toFixed(1)}ms`);
  });

  // 4. fetchUserInfo
  await check('用户信息获取 fetchUserInfo', async () => {
    const res = await post('/v1internal:fetchUserInfo');
    if (res.status !== 200) throw new Error(`HTTP状态码异常: ${res.status}`);
    if (!res.data.email) throw new Error('缺少 email');
    console.log(`   - 用户: ${res.data.name} (${res.data.email}) | 响应耗时: ${res.elapsed.toFixed(1)}ms`);
  });

  // 5. fetchAdminControls
  await check('管理权限控制 fetchAdminControls', async () => {
    const res = await post('/v1internal:fetchAdminControls');
    if (res.status !== 200) throw new Error(`HTTP状态码异常: ${res.status}`);
    if (!res.data.adminControls?.allFeaturesEnabled) throw new Error('未放行全部特性');
    console.log(`   - allFeaturesEnabled: true | 响应耗时: ${res.elapsed.toFixed(1)}ms`);
  });

  // 6. retrieveUserQuotaSummary
  await check('用户配额查询 retrieveUserQuotaSummary', async () => {
    const res = await post('/v1internal:retrieveUserQuotaSummary');
    if (res.status !== 200) throw new Error(`HTTP状态码异常: ${res.status}`);
    const quotas = res.data.userQuotaSummary?.quotas;
    if (!Array.isArray(quotas) || quotas.length === 0) throw new Error('配额列表为空');
    console.log(`   - 模型配额条数: ${quotas.length} 条 | 响应耗时: ${res.elapsed.toFixed(1)}ms`);
  });

  // 7. 指标/遥测快速拦截
  await check('遥测/指标防火墙 recordCodeAssistMetrics (0ms 拦截)', async () => {
    const res = await post('/v1internal:recordCodeAssistMetrics', { event: 'ping' });
    if (res.status !== 200) throw new Error(`HTTP状态码异常: ${res.status}`);
    if (res.elapsed > 100) throw new Error(`指标拦截耗时过高: ${res.elapsed.toFixed(1)}ms`);
    console.log(`   - 拦截响应耗时: ${res.elapsed.toFixed(1)}ms (成功阻断外网连接)`);
  });

  // 8. 未知探测安全兜底
  await check('未知探测接口安全兜底 (200 OK 绝不阻塞)', async () => {
    const res = await post('/v1internal:checkUrlAntivirus', { url: 'https://test.com' });
    if (res.status !== 200) throw new Error(`HTTP状态码异常: ${res.status}`);
    console.log(`   - 兜底响应耗时: ${res.elapsed.toFixed(1)}ms`);
  });

  console.log('\n========================================================');
  console.log(`📊 体检结果: 全部 ${passed + failed} 项测试 | ✅ 通过: ${passed} | ❌ 失败: ${failed}`);
  console.log('========================================================\n');

  if (failed > 0) process.exit(1);
}

runTests();
