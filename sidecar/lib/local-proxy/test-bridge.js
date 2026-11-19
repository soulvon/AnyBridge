import { normalizeOpenAI, normalizeRequest, normalizeToolParameters } from './normalize.js';
import {
  antigravityErrorSnapshot,
  createGeminiStreamFromOpenAIChat,
  extractText,
  extractToolCalls,
  responseObject,
  responseReasoningItems,
  sendGemini,
  sendGeminiStream,
  sendOpenAIChat,
  sendOpenAIResponses,
  upstreamReasoningText,
  writeAntigravityStreamError,
} from './response-emitters.js';
import {
  buildExposedIdLookup,
  geminiModelFromPath,
  isLocalProxySelfTarget,
  mapClaudeDesktopModel,
  renderedProxyRouteId,
  resolveAntigravityProxyModel,
  resolveClaudeDesktopRole,
  resolveProxyModel,
  routeSupportsKind,
  sameRoute,
  stripOneMContextMarker,
} from './routes.js';
import {
  RETRYABLE_STATUS,
  applyParamOverrides,
  applyToolEnhancement,
  classifyFailures,
  failureMessage,
  readableErrorText,
  upstreamErrorText,
} from './transport.js';
import {
  anthropicTools,
  geminiGenerationConfig,
  geminiStreamApiPath,
  geminiTools,
  openAIResponsesInput,
  openAITools,
  responsesToolChoice,
  upstreamBody,
} from './upstream-payload.js';

export function buildLocalProxyTestExports(execute) {
  return {
    RETRYABLE_STATUS,
    buildExposedIdLookup,
    renderedProxyRouteId,
    responseObject,
    isLocalProxySelfTarget,
    sameRoute,
    routeSupportsKind,
    normalizeRequest,
    normalizeOpenAI,
    openAIResponsesInput,
    extractText,
    extractToolCalls,
    upstreamReasoningText,
    responseReasoningItems,
    execute,
    sendOpenAIChat,
    sendOpenAIResponses,
    applyParamOverrides,
    applyToolEnhancement,
    upstreamBody,
    openAITools,
    anthropicTools,
    responsesToolChoice,
    normalizeToolParameters,
    geminiTools,
    geminiGenerationConfig,
    geminiStreamApiPath,
    antigravityErrorSnapshot,
    writeAntigravityStreamError,
    upstreamErrorText,
    readableErrorText,
    failureMessage,
    classifyFailures,
    createGeminiStreamFromOpenAIChat,
    sendGemini,
    sendGeminiStream,
    geminiModelFromPath,
    stripOneMContextMarker,
    resolveClaudeDesktopRole,
    mapClaudeDesktopModel,
    resolveProxyModelForTest(model, kind, scope, providers, providersJson) {
      if (scope === 'antigravity') {
        return resolveAntigravityProxyModel(model, providers, providersJson);
      }
      return resolveProxyModel(model, kind, { scope });
    },
  };
}

