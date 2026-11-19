// sidecar/lib/cursor/proto-parsers-mcp.js — Cursor Google Struct/Value 与 MCP 上下文/工具定义解析器

import { fieldToInt, fieldToString, getAllFields, getField, parseFields } from '../../proto.js';

export function parseGoogleValue(buf) {
  const fields = parseFields(buf);
  if (getField(fields, 1, 0)) return null;
  const number = getField(fields, 2, 1);
  if (number?.value && Buffer.isBuffer(number.value) && number.value.length === 8) {
    return number.value.readDoubleLE(0);
  }
  const string = getField(fields, 3, 2);
  if (string) return fieldToString(string);
  const bool = getField(fields, 4, 0);
  if (bool) return fieldToInt(bool) === 1;
  const struct = getField(fields, 5, 2);
  if (struct) return parseGoogleStruct(struct.value);
  const list = getField(fields, 6, 2);
  if (list) return parseGoogleList(list.value);
  return {};
}

function parseGoogleStruct(buf) {
  const out = {};
  for (const field of getAllFields(parseFields(buf), 1).filter(item => item.wireType === 2)) {
    const entry = parseFields(field.value);
    const key = fieldToString(getField(entry, 1, 2));
    const value = getField(entry, 2, 2);
    if (key && value) out[key] = parseGoogleValue(value.value);
  }
  return out;
}

function parseGoogleList(buf) {
  return getAllFields(parseFields(buf), 1)
    .filter(field => field.wireType === 2)
    .map(field => parseGoogleValue(field.value));
}

export function parseMcpToolDefinition(buf) {
  const fields = parseFields(buf);
  const schema = getField(fields, 3, 2);
  const providerIdentifier = fieldToString(getField(fields, 4, 2));
  const toolName = fieldToString(getField(fields, 5, 2));
  return {
    name: fieldToString(getField(fields, 1, 2)),
    description: fieldToString(getField(fields, 2, 2)),
    providerIdentifier,
    toolName: toolName || fieldToString(getField(fields, 1, 2)),
    inputSchema: schema ? parseGoogleValue(schema.value) : null,
  };
}

export function parseMcpTools(buf) {
  return getAllFields(parseFields(buf), 1)
    .filter(field => field.wireType === 2)
    .map(field => parseMcpToolDefinition(field.value))
    .filter(tool => tool.toolName || tool.name);
}

function parseMcpToolDescriptor(buf) {
  const fields = parseFields(buf);
  return {
    toolName: fieldToString(getField(fields, 1, 2)),
    definitionPath: fieldToString(getField(fields, 2, 2)),
  };
}

function parseMcpDescriptor(buf) {
  const fields = parseFields(buf);
  return {
    serverName: fieldToString(getField(fields, 1, 2)),
    serverIdentifier: fieldToString(getField(fields, 2, 2)),
    folderPath: fieldToString(getField(fields, 3, 2)),
    serverUseInstructions: fieldToString(getField(fields, 4, 2)),
    tools: getAllFields(fields, 5)
      .filter(field => field.wireType === 2)
      .map(field => parseMcpToolDescriptor(field.value))
      .filter(tool => tool.toolName),
  };
}

export function parseMcpFileSystemOptions(buf) {
  const fields = parseFields(buf);
  return {
    enabled: fieldToInt(getField(fields, 1, 0)) === 1,
    workspaceProjectDir: fieldToString(getField(fields, 2, 2)),
    descriptors: getAllFields(fields, 3)
      .filter(field => field.wireType === 2)
      .map(field => parseMcpDescriptor(field.value))
      .filter(desc => desc.serverIdentifier || desc.serverName),
  };
}

export function parseMcpInstructions(buf) {
  const fields = parseFields(buf);
  return {
    serverName: fieldToString(getField(fields, 1, 2)),
    instructions: fieldToString(getField(fields, 2, 2)),
  };
}
