// antigravity-handler.js — Google Antigravity (v1internal) 专有协议适配器
//
// 负责：
// 1. 识别 Antigravity IDE / CLI 请求路径（/v1internal:* 或 /antigravity/v1internal:*）
// 2. 模拟与响应用户认证/配额查询（loadCodeAssist, retrieveUserQuotaSummary, onboardUser）
// 3. 动态注入自定义模型列表到 Antigravity 下拉列表（fetchAvailableModels）
// 4. 将 v1internal 的 streamGenerateContent / generateContent 格式转换为通用格式并回传

export function isAntigravityPath(pathname) {
  const p = String(pathname || '');
  return p.startsWith('/v1internal:')
    || p.startsWith('/antigravity/v1internal:')
    || p === '/antigravity'
    || p.startsWith('/antigravity/');
}

export function getAntigravityMethod(pathname) {
  const p = String(pathname || '');
  const colonIndex = p.lastIndexOf(':');
  if (colonIndex !== -1) {
    const afterColon = p.slice(colonIndex + 1).split(/[?#/]/)[0];
    if (afterColon) return afterColon;
  }
  const m = p.match(/v1internal:([^?#/]+)/);
  return m ? m[1] : '';
}

const DEFAULT_ANTIGRAVITY_MODELS = [
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro', desc: 'Google Gemini 3 Pro' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', desc: 'Google Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', desc: 'Google Gemini 2.5 Flash' },
  { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', desc: 'Anthropic Claude 3.7 Sonnet' },
  { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', desc: 'Anthropic Claude 3.5 Sonnet' },
  { id: 'deepseek-chat', name: 'DeepSeek-V3', desc: 'DeepSeek V3' },
  { id: 'deepseek-reasoner', name: 'DeepSeek-R1', desc: 'DeepSeek R1' },
  { id: 'gpt-4o', name: 'GPT-4o', desc: 'OpenAI GPT-4o' },
];

export function buildAntigravityModelsList(providersJson = {}) {
  const seen = new Set();
  const result = [];

  const addModel = (modelId, displayName, desc) => {
    if (!modelId) return;
    const cleanId = String(modelId).replace(/^models\//, '').trim();
    if (!cleanId || seen.has(cleanId)) return;
    seen.add(cleanId);
    result.push({
      name: `models/${cleanId}`,
      model: `models/${cleanId}`,
      displayName: displayName || cleanId,
      description: desc || `${displayName || cleanId} (AnyBridge BYOK)`,
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
    });
  };

  // 1. 优先注入用户配置的 antigravityConfigs
  const agConfigs = Array.isArray(providersJson.antigravityConfigs) ? providersJson.antigravityConfigs : [];
  for (const cfg of agConfigs) {
    if (!cfg) continue;
    if (cfg.defaultModel) {
      addModel(cfg.defaultModel, `${cfg.name || cfg.defaultModel} (AnyBridge)`, `通过供应商 ${cfg.name || cfg.sourceProviderName || 'AnyBridge'}`);
    }
    if (Array.isArray(cfg.models)) {
      for (const m of cfg.models) {
        addModel(m, `${m} (${cfg.name || 'AnyBridge'})`);
      }
    }
    if (Array.isArray(cfg.modelCatalog)) {
      for (const entry of cfg.modelCatalog) {
        if (entry && entry.model) {
          addModel(entry.model, entry.displayName || entry.model);
        }
      }
    }
  }

  // 2. 补充供应商连接池中配置的模型
  const providers = Array.isArray(providersJson.providers) ? providersJson.providers : [];
  for (const p of providers) {
    if (!p || p.enabled === false) continue;
    if (p.defaultModel) {
      addModel(p.defaultModel, `${p.defaultModel} (${p.name || 'AnyBridge'})`);
    }
  }

  // 3. 补充推荐的默认模型兜底
  for (const def of DEFAULT_ANTIGRAVITY_MODELS) {
    addModel(def.id, `${def.name} (AnyBridge)`, def.desc);
  }

  return result;
}

export function cleanAntigravityModelId(model) {
  if (!model) return '';
  return String(model).replace(/^models\//, '').trim();
}

/**
 * 伪造 Antigravity 配额及服务能力，使 IDE 不报 503 与 Quota Exhausted 错误
 */
export function mockAntigravityLoadCodeAssist() {
  return {
    currentTier: {
      id: 'standard-tier',
      name: 'Standard Tier',
    },
    paidTier: {
      id: 'paid-tier',
      availableCredits: [
        {
          creditType: 'GOOGLE_ONE_AI',
          creditAmount: 1000000,
          minimumCreditAmountForUsage: 0,
        },
      ],
    },
    cloudaicompanionProject: 'projects/antigravity-local',
  };
}

export function mockAntigravityUserQuotaSummary() {
  return {
    userQuotaSummary: {
      quotas: [
        {
          modelId: 'gemini-3-pro',
          remainingQuota: 1000,
          resetTime: '2099-01-01T00:00:00Z',
          status: 'ACTIVE',
        },
      ],
    },
  };
}
