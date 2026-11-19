// lib/cursor/tool-definitions.js - Modular component split from cursor-proxy.js.

import fs from "node:fs";
import path from "node:path";

export function cursorModePrompt(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  if (normalized === 'ask') return 'Current Cursor mode: Ask. Prefer explanation and guidance.';
  if (normalized === 'plan') return 'Current Cursor mode: Plan. Prefer a short, actionable plan before implementation details.';
  if (normalized === 'debug') return 'Current Cursor mode: Debug. Focus on root cause, evidence, and concrete checks.';
  return 'Current Cursor mode: Agent. Be direct and useful.';
}


function sanitizeMcpFunctionName(value) {
  const cleaned = String(value || 'tool').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  return cleaned || 'tool';
}


function loadMcpDefinition(definitionPath) {
  const file = String(definitionPath || '').trim();
  if (!file) return { description: '', inputSchema: null };
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  const inputSchema = parsed.arguments
    || parsed.inputSchema
    || parsed.input_schema
    || parsed.schema
    || parsed.parameters
    || null;
  return {
    description: String(parsed.description || '').trim(),
    inputSchema,
  };
}


function normalizeMcpSchema(schema) {
  const fallback = { type: 'object', properties: {}, additionalProperties: true };
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return fallback;
  let obj = { ...schema };
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(obj[key])) {
      const branch = obj[key].find(item => item && typeof item === 'object' && !Array.isArray(item));
      if (branch) obj = { ...branch };
      break;
    }
  }
  if (obj.type !== 'object') obj.type = 'object';
  if (!obj.properties || typeof obj.properties !== 'object' || Array.isArray(obj.properties)) {
    obj.properties = {};
  }
  if (obj.additionalProperties === undefined) obj.additionalProperties = true;
  return obj;
}


function mcpEntriesForSession(sess) {
  if (!sess) return [];
  const entries = [];
  const seen = new Set();
  const add = ({ serverName, serverID, toolName, description, inputSchema }) => {
    const realToolName = String(toolName || '').trim();
    let providerID = String(serverID || serverName || '').trim();
    let displayServerName = String(serverName || providerID || '').trim();
    if (!realToolName || (!providerID && !displayServerName)) return;
    if (!providerID) providerID = displayServerName;
    if (!displayServerName) displayServerName = providerID;
    const key = `${providerID}\0${realToolName}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({
      serverName: displayServerName,
      serverID: providerID,
      toolName: realToolName,
      description: String(description || '').trim(),
      inputSchema: normalizeMcpSchema(inputSchema),
    });
  };

  for (const tool of [
    ...(sess.mcpTools || []),
    ...(sess.requestContext?.tools || []),
  ]) {
    add({
      serverName: tool.providerIdentifier || tool.provider_identifier || tool.name,
      serverID: tool.providerIdentifier || tool.provider_identifier || tool.name,
      toolName: tool.toolName || tool.tool_name || tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema || tool.input_schema,
    });
  }

  const descriptors = [
    ...(sess.mcpFileSystemOptions?.descriptors || []),
    ...(sess.requestContext?.mcpFileSystemOptions?.descriptors || []),
  ];
  for (const desc of descriptors) {
    for (const tool of desc.tools || []) {
      let loaded = { description: '', inputSchema: null };
      if (tool.definitionPath) {
        loaded = loadMcpDefinition(tool.definitionPath);
      }
      add({
        serverName: desc.serverName,
        serverID: desc.serverIdentifier,
        toolName: tool.toolName,
        description: loaded.description || desc.serverUseInstructions,
        inputSchema: loaded.inputSchema,
      });
    }
  }
  return entries;
}


function cursorMcpToolDefinitions(sess) {
  const entries = mcpEntriesForSession(sess);
  if (!sess) return [];
  sess.mcpMap = {};
  const out = [];
  entries.forEach((entry, index) => {
    const name = `mcp_${index}__${sanitizeMcpFunctionName(entry.toolName)}`;
    sess.mcpMap[name] = {
      serverName: entry.serverName,
      serverID: entry.serverID,
      toolName: entry.toolName,
    };
    out.push({
      type: 'function',
      function: {
        name,
        description: [
          `[MCP server: ${entry.serverName} (id: ${entry.serverID}) | real tool: ${entry.toolName}]`,
          entry.description || `MCP tool "${entry.toolName}" on server "${entry.serverName}".`,
        ].join('\n'),
        parameters: entry.inputSchema,
      },
    });
  });
  return out;
}


export function mcpToolsPrompt(sess) {
  const map = sess?.mcpMap || {};
  const names = Object.keys(map);
  if (!names.length) return '';
  const rows = names.map(name => {
    const ref = map[name];
    return `- ${name}: ${ref.serverName} (${ref.serverID}) -> ${ref.toolName}`;
  });
  return [
    '',
    '<mcp_tools>',
    'Each MCP tool is exposed as its own OpenAI function. Call the exact function name shown here; do not invent composite server-tool names.',
    ...rows,
    '</mcp_tools>',
  ].join('\n');
}


function cursorReadToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read a UTF-8 text file from the current Cursor workspace. Use this before discussing local file contents that were not provided in chat.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative or absolute file path to read.',
          },
          offset: {
            type: 'integer',
            description: 'Optional 1-based starting line.',
          },
          limit: {
            type: 'integer',
            description: 'Optional maximum number of lines to read.',
          },
          include_line_numbers: {
            type: 'boolean',
            description: 'Whether Cursor should include line numbers in the returned content.',
          },
        },
        required: ['path'],
      },
    },
  };
}


function cursorGlobToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'Glob',
      description: [
        'Search for files matching a glob pattern in the current Cursor workspace.',
        'Use this when you need to find files by name patterns before reading them.',
        'Patterns not starting with **/ are matched recursively from the workspace root.',
      ].join('\n'),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          glob_pattern: {
            type: 'string',
            description: 'Glob pattern to match files against, for example *.js or **/test/**/*.ts.',
          },
          target_directory: {
            type: 'string',
            description: 'Optional workspace-relative or absolute directory to search. Defaults to the Cursor workspace root.',
          },
        },
        required: ['glob_pattern'],
      },
    },
  };
}


function cursorGrepToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'Grep',
      description: [
        'Search file contents with ripgrep-compatible regular expressions.',
        'Use this for exact symbols, strings, or regex patterns; use Glob for file-name patterns.',
        'Output modes are content, files_with_matches, and count.',
      ].join('\n'),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pattern: {
            type: 'string',
            description: 'Regular expression pattern to search for.',
          },
          path: {
            type: 'string',
            description: 'Optional file or directory to search. Defaults to the Cursor workspace root.',
          },
          glob: {
            type: 'string',
            description: 'Optional glob filter passed to ripgrep.',
          },
          output_mode: {
            type: 'string',
            enum: ['content', 'files_with_matches', 'count'],
            description: 'Result format. Defaults to content.',
          },
          '-A': {
            type: 'integer',
            description: 'Number of lines to show after each match in content mode.',
          },
          '-B': {
            type: 'integer',
            description: 'Number of lines to show before each match in content mode.',
          },
          '-C': {
            type: 'integer',
            description: 'Number of context lines to show before and after each match in content mode.',
          },
          '-i': {
            type: 'boolean',
            description: 'Case-insensitive search.',
          },
          type: {
            type: 'string',
            description: 'Optional ripgrep file type such as js, py, rust, go, or java.',
          },
          head_limit: {
            type: 'integer',
            minimum: 0,
            description: 'Limit result size.',
          },
          multiline: {
            type: 'boolean',
            description: 'Enable multiline search.',
          },
        },
        required: ['pattern'],
      },
    },
  };
}


function cursorShellToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'Shell',
      description: [
        'Execute a terminal command in the current Cursor workspace.',
        'Use this for build, test, package manager, git, and other terminal operations.',
        'Use Read, Glob, Grep, Write, StrReplace, and Delete for file operations instead of shell commands.',
      ].join('\n'),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: {
            type: 'string',
            description: 'Command to execute.',
          },
          working_directory: {
            type: 'string',
            description: 'Optional absolute working directory. Defaults to Cursor workspace root.',
          },
          block_until_ms: {
            type: 'integer',
            minimum: 0,
            description: 'Milliseconds to wait before Cursor backgrounds the command. Defaults to 30000. Set 0 for immediate background.',
          },
          description: {
            type: 'string',
            description: 'Short 5-10 word description of what this command does.',
          },
        },
        required: ['command'],
      },
    },
  };
}


function cursorWriteToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'Write',
      description: [
        'Write complete UTF-8 text contents to a file in the current Cursor workspace.',
        'This overwrites the existing file if it exists; prefer StrReplace for targeted edits to existing files.',
      ].join('\n'),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative or absolute path to write.',
          },
          contents: {
            type: 'string',
            description: 'Complete file contents to write.',
          },
        },
        required: ['path', 'contents'],
      },
    },
  };
}


function cursorStrReplaceToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'StrReplace',
      description: [
        'Perform an exact string replacement in an existing UTF-8 text file.',
        'The old_string must match the current file contents exactly; use replace_all only when every occurrence should change.',
      ].join('\n'),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the file to modify.',
          },
          old_string: {
            type: 'string',
            description: 'Exact text to replace.',
          },
          new_string: {
            type: 'string',
            description: 'Replacement text. Empty string deletes the matched text.',
          },
          replace_all: {
            type: 'boolean',
            description: 'Replace every occurrence of old_string. Defaults to false.',
          },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  };
}


function cursorDeleteToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'Delete',
      description: 'Delete a file from the current Cursor workspace.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative or absolute file path to delete.',
          },
        },
        required: ['path'],
      },
    },
  };
}


function cursorCreatePlanToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'CreatePlan',
      description: 'Create a structured plan for a multi-step Cursor task. Pass short TODO items; use AddTodo and UpdateTodo later to keep the plan current.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: {
            type: 'string',
            description: 'Short plan title.',
          },
          overview: {
            type: 'string',
            description: 'One-paragraph approach summary.',
          },
          todos: {
            type: 'array',
            description: 'Initial TODO items in execution order.',
            items: { type: 'string' },
          },
        },
        required: ['name', 'overview', 'todos'],
      },
    },
  };
}


function cursorAddTodoToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'AddTodo',
      description: 'Append one TODO item to the active Cursor plan. If no plan exists, call CreatePlan first.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: {
            type: 'string',
            description: 'Short imperative TODO item.',
          },
        },
        required: ['content'],
      },
    },
  };
}


function cursorUpdateTodoToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'UpdateTodo',
      description: 'Update a TODO status on the active Cursor plan. Use id when known, or content as a prefix match.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            description: 'TODO id from the active plan.',
          },
          content: {
            type: 'string',
            description: 'Alternative prefix match on TODO content.',
          },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'cancelled'],
            description: 'New TODO status.',
          },
        },
        required: ['status'],
      },
    },
  };
}


function cursorSwitchModeToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'SwitchMode',
      description: 'Switch the active Cursor interaction mode when the task is better suited to agent, ask, plan, or debug. Continue after the user approves or rejects the switch.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target_mode_id: {
            type: 'string',
            enum: ['agent', 'ask', 'plan', 'debug'],
            description: 'Target mode.',
          },
          explanation: {
            type: 'string',
            description: 'Short reason shown to the user.',
          },
        },
        required: ['target_mode_id', 'explanation'],
      },
    },
  };
}


function cursorListMcpResourcesToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'ListMcpResources',
      description: 'List MCP resources advertised by connected Cursor MCP servers. Resources are not tools; use mcp_* functions for MCP tool calls.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          server: {
            type: 'string',
            description: 'Optional MCP server identifier.',
          },
        },
        required: [],
      },
    },
  };
}


function cursorFetchMcpResourceToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'FetchMcpResource',
      description: 'Read a specific MCP resource from a connected Cursor MCP server.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          server: {
            type: 'string',
            description: 'MCP server identifier.',
          },
          uri: {
            type: 'string',
            description: 'Resource URI.',
          },
          downloadPath: {
            type: 'string',
            description: 'Optional workspace-relative path where Cursor should save the resource.',
          },
        },
        required: ['server', 'uri'],
      },
    },
  };
}


function cursorCallMcpToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'CallMcpTool',
      description: 'Call an MCP tool by server identifier and tool name. Prefer the specific mcp_* functions when they are available.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          server: {
            type: 'string',
            description: 'MCP server identifier.',
          },
          toolName: {
            type: 'string',
            description: 'MCP tool name.',
          },
          arguments: {
            type: 'object',
            description: 'Arguments for the MCP tool.',
            additionalProperties: true,
          },
        },
        required: ['server', 'toolName', 'arguments'],
      },
    },
  };
}


export function cursorReadTools(sess = null) {
  const base = [
    cursorReadToolDefinition(),
    cursorGlobToolDefinition(),
    cursorGrepToolDefinition(),
    cursorShellToolDefinition(),
    cursorWriteToolDefinition(),
    cursorStrReplaceToolDefinition(),
    cursorDeleteToolDefinition(),
    cursorCreatePlanToolDefinition(),
    cursorAddTodoToolDefinition(),
    cursorUpdateTodoToolDefinition(),
    cursorSwitchModeToolDefinition(),
  ];
  const mcpTools = cursorMcpToolDefinitions(sess);
  if (mcpTools.length) {
    base.push(cursorListMcpResourcesToolDefinition());
    base.push(cursorFetchMcpResourceToolDefinition());
    base.push(cursorCallMcpToolDefinition());
    base.push(...mcpTools);
  }
  return base;
}

