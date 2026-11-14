// Gemini 原生 functionDeclarations.parameters 只接受 OpenAPI Schema 子集。
// 标准 JSON Schema 里的 $schema / $defs / additionalProperties / exclusiveMinimum 等字段
// 会让 Vertex 直接 400（Invalid JSON payload received）。这里做无损或近无损降级：
//   - 白名单保留 Gemini Schema 合法字段；
//   - properties 按「属性名 → schema」递归（不能把属性名当字段名过滤掉）；
//   - type 数组 ["string","null"] 折叠为单类型 + nullable；
//   - oneOf 近似降级为 anyOf（Gemini 只支持 anyOf）；allOf 无法表达，丢弃；
//   - enum 里的 null 过滤掉（Gemini enum 不接受 null）。
// 收敛点：local-proxy（网关出站 Gemini）与 handlers/chat（Codeium 拦截）共用这一份。

const ALLOWED_KEYS = new Set([
  'type', 'format', 'title', 'description', 'nullable', 'default',
  'enum', 'items', 'properties', 'required', 'minimum', 'maximum',
  'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern',
  'anyOf', 'propertyOrdering',
]);

const GOOGLE_TYPE_BY_NAME = {
  STRING: 'STRING',
  NUMBER: 'NUMBER',
  INTEGER: 'INTEGER',
  BOOLEAN: 'BOOLEAN',
  ARRAY: 'ARRAY',
  OBJECT: 'OBJECT',
};

function normalizeTypeValue(type) {
  if (typeof type === 'number' && Number.isInteger(type) && type >= 1 && type <= 6) {
    return ['STRING', 'NUMBER', 'INTEGER', 'BOOLEAN', 'ARRAY', 'OBJECT'][type - 1];
  }
  if (typeof type === 'string') return GOOGLE_TYPE_BY_NAME[type.toUpperCase()] || type;
  return type;
}

export function sanitizeGeminiSchema(schema) {
  if (schema == null || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema);

  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!ALLOWED_KEYS.has(key)) continue;
    if (key === 'properties') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const props = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        props[propName] = sanitizeGeminiSchema(propSchema);
      }
      out.properties = props;
      continue;
    }
    if (key === 'required') {
      if (Array.isArray(value)) out.required = value.map(String);
      continue;
    }
    if (key === 'enum') {
      if (Array.isArray(value)) out.enum = value.filter((item) => item !== null);
      continue;
    }
    out[key] = sanitizeGeminiSchema(value);
  }

  if (Array.isArray(schema.type)) {
    const nullable = schema.type.some((t) => String(t).toLowerCase() === 'null');
    const types = schema.type.filter((t) => String(t).toLowerCase() !== 'null');
    out.type = normalizeTypeValue(types[0] || 'object');
    if (nullable) out.nullable = true;
  } else if (out.type !== undefined) {
    out.type = normalizeTypeValue(out.type);
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length) {
    const existing = Array.isArray(out.anyOf) ? out.anyOf : [];
    out.anyOf = [...existing, ...schema.oneOf.map(sanitizeGeminiSchema)];
  }

  return out;
}

/** 工具参数清洗入口：空壳 schema 补成合法空对象，避免上游把 parameters 判为非法。 */
export function cleanGeminiToolParameters(raw) {
  const cleaned = sanitizeGeminiSchema(raw && typeof raw === 'object' ? raw : null);
  if (!cleaned || typeof cleaned !== 'object' || Array.isArray(cleaned) || !Object.keys(cleaned).length) {
    return { type: 'object', properties: {} };
  }
  return cleaned;
}
