// sidecar/lib/local-proxy/execute-helpers.js — local-proxy 执行辅助：自环目标展开、负载自愈、错误归并与 Gemini 上下文归一化

import { healGemini400Payload } from '../google-gemini.js';
import { chatErrorToResponseError } from '../responses-chat-transform.js';
import { tryHeal } from '../self-heal.js';
import { normalizeRequest } from './normalize.js';
import {
  LocalProxyUpstreamError,
  isLocalProxySelfTarget,
  resolveProxyModel,
  sameRoute,
} from './routes.js';
import {
  classifyFailures,
  failureMessage,
  safeParse,
  upstreamErrorText,
} from './transport.js';

export function expandResolvedTargets(targets, resolvedRoute, scope, failures) {
  const resolvedTargets = [];
  for (const target of targets) {
    if (!isLocalProxySelfTarget(target)) {
      resolvedTargets.push(target);
      continue;
    }
    const inner = resolveProxyModel(target.model || '', 'chat', { scope });
    if (inner.error || !inner.route) {
      failures.push({
        providerName: target.providerId,
        message: `自环目标模型 ${target.model || '(空)'} 无法解析: ${inner.error || '未命中路由'}`,
      });
      continue;
    }
    if (sameRoute(inner.route, resolvedRoute)) {
      failures.push({
        providerName: target.providerId,
        message: `路由 ${resolvedRoute.id} 的目标指向本地网关自身，且模型 ${target.model} 仍解析回本路由，会形成无限请求环。请把该路由的目标改为真实供应商。`,
      });
      continue;
    }
    const innerTarget = inner.slot?.targets?.[0];
    if (!innerTarget) {
      failures.push({
        providerName: target.providerId,
        message: `自环目标模型 ${target.model} 对应的路由 ${inner.route.id} 没有可用目标`,
      });
      continue;
    }
    resolvedTargets.push(innerTarget);
  }
  return resolvedTargets;
}

export function trySelfHealUpstreamPayload({
  conn,
  payload,
  statusCode,
  rawErrorText,
  safeErrorText,
  selfHealCfg,
  healState,
}) {
  if (conn.format === 'anthropic' && selfHealCfg.enabled) {
    const healed = tryHeal(payload, statusCode, rawErrorText, selfHealCfg, healState);
    if (healed.healed) {
      console.log(`[local-proxy] [self-heal] ${healed.kind} triggered, retrying`);
      return payload;
    }
  }
  if (conn.format === 'gemini' && statusCode === 400) {
    const healed = healGemini400Payload(payload, safeErrorText, healState);
    if (healed) {
      console.log(`[local-proxy] [self-heal] ${healed.kind} triggered, retrying`);
      return healed.payload;
    }
  }
  return null;
}

export function throwAggregatedUpstreamFailure({ failures, rawProviderErrors, tracker, model }) {
  const lastUpstreamResponse = [...failures].reverse().find((f) => f.statusCode && typeof f.body === 'string');
  const lastRawErrorText = lastUpstreamResponse ? upstreamErrorText(lastUpstreamResponse.body) : '';
  if (lastUpstreamResponse && rawProviderErrors && lastRawErrorText) {
    const classification = classifyFailures([lastUpstreamResponse]);
    tracker.fail('upstream-http', `${lastUpstreamResponse.providerName || 'provider'}: HTTP ${lastUpstreamResponse.statusCode}: ${lastUpstreamResponse.message || ''}`);
    tracker.finish();
    throw new LocalProxyUpstreamError(`upstream HTTP ${lastUpstreamResponse.statusCode}`, {
      status: classification.status,
      type: classification.type,
      upstreamResponse: {
        statusCode: classification.status,
        headers: lastUpstreamResponse.headers || {},
        body: lastUpstreamResponse.wireApi === 'chat' && lastUpstreamResponse.body
          ? JSON.stringify(chatErrorToResponseError(safeParse(lastUpstreamResponse.body)))
          : lastUpstreamResponse.body,
      },
    });
  }

  const classification = classifyFailures(failures);
  const emptyResponse403 = failures.some((f) => f.statusCode === 403 && !upstreamErrorText(f.body));
  const hint = emptyResponse403 ? '。上游返回的 403 不带可读错误信息，常见于中转站风控拦截了该渠道、或该模型未开通，建议换一个渠道或核对上游模型名' : '';
  const message = failures.length
    ? `模型「${model}」的上游目标都失败了：${failures.map(failureMessage).join('；')}${hint}`
    : `模型「${model}」没有可用的上游目标。`;
  tracker.fail('failover', message);
  tracker.finish();
  throw new LocalProxyUpstreamError(message, classification);
}

export function buildAntigravityNormalizedCtx(attachScope, source, fallbackJson, targetModel, extraFields = {}) {
  return attachScope(normalizeRequest('gemini', {
    ...source,
    model: targetModel,
    ...extraFields,
    generationConfig: source.generationConfig || source.generation_config || fallbackJson.generationConfig || fallbackJson.generation_config,
    systemInstruction: source.systemInstruction || source.system_instruction || fallbackJson.systemInstruction || fallbackJson.system_instruction,
    tools: source.tools || fallbackJson.tools,
    toolConfig: source.toolConfig || source.tool_config || fallbackJson.toolConfig || fallbackJson.tool_config,
    safetySettings: source.safetySettings || source.safety_settings || fallbackJson.safetySettings || fallbackJson.safety_settings,
    cachedContent: source.cachedContent || source.cached_content || fallbackJson.cachedContent || fallbackJson.cached_content,
  }));
}
