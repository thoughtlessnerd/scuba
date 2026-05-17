#!/usr/bin/env node
/**
 * Stdio MCP server exposing scuba's agent-orchestration tools to MOTHER.
 *
 * Spawned per-process by Claude Code. Configure with:
 *   claude mcp add scuba node /absolute/path/to/dist/mcp-server.js
 *
 * Talks to the running scuba HTTP server over localhost. Override the URL with
 *   SCUBA_URL=http://127.0.0.1:4242
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const SCUBA_URL = (process.env.SCUBA_URL ?? 'http://127.0.0.1:4242').replace(/\/$/, '');

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'list_chats',
    description: 'List Telegram chats available to bind workers to. Returns {chatId, title, type}.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => http('GET', '/api/agent/chats'),
  },
  {
    name: 'list_groups',
    description: 'List all task groups.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => http('GET', '/api/agent/groups'),
  },
  {
    name: 'list_terminals',
    description:
      'List worker terminals with their current state (working/idle/awaiting-choice). Optionally filter by groupId.',
    inputSchema: {
      type: 'object',
      properties: { groupId: { type: 'string', description: 'Filter to this group only' } },
      additionalProperties: false,
    },
    handler: async (args) => {
      const q = args.groupId ? `?groupId=${encodeURIComponent(String(args.groupId))}` : '';
      return http('GET', `/api/agent/terminals${q}`);
    },
  },
  {
    name: 'create_group',
    description:
      'Create a new task group. Name should be short kebab-case describing the task.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        color: { type: 'string', description: 'Hex color like #9ece6a (optional)' },
        taskDescription: { type: 'string', description: 'One-line task description (optional)' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (args) => http('POST', '/api/agent/groups', args),
  },
  {
    name: 'spawn_worker',
    description:
      'Spawn a Claude Code worker in `cwd`. The worker boots in idle and then receives `initialTask` ' +
      'as typed input. `chatId` is the Telegram chat where its human-input prompts will be routed.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Absolute path or path starting with ~' },
        name: { type: 'string', description: 'Short ≤15-char descriptive name' },
        groupId: { type: 'string', description: 'Group id from create_group / list_groups' },
        chatId: {
          type: 'string',
          description: 'Telegram chatId from list_chats (for human-input routing)',
        },
        systemPrompt: { type: 'string', description: 'Worker system prompt' },
        initialTask: { type: 'string', description: 'Task to type into the worker once it boots' },
      },
      required: ['cwd', 'name', 'systemPrompt', 'initialTask'],
      additionalProperties: false,
    },
    handler: async (args) => http('POST', '/api/agent/terminals', args),
  },
  {
    name: 'send_to_terminal',
    description:
      'Send a text message into a worker as typed input. Refuses if the worker is currently ' +
      'awaiting human input (the human answers those via Telegram buttons, not you).',
    inputSchema: {
      type: 'object',
      properties: {
        terminalId: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['terminalId', 'text'],
      additionalProperties: false,
    },
    handler: async (args) =>
      http('POST', `/api/agent/terminals/${encodeURIComponent(String(args.terminalId))}/send`, {
        text: args.text,
      }),
  },
  {
    name: 'kill_terminal',
    description: 'Kill a worker terminal and remove it from the database.',
    inputSchema: {
      type: 'object',
      properties: { terminalId: { type: 'string' } },
      required: ['terminalId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      await http('DELETE', `/api/agent/terminals/${encodeURIComponent(String(args.terminalId))}`);
      return { ok: true };
    },
  },
  {
    name: 'read_terminal_tail',
    description: 'Read the last N visible lines from a worker. Use to inspect status directly.',
    inputSchema: {
      type: 'object',
      properties: {
        terminalId: { type: 'string' },
        lines: { type: 'number', description: 'Default 40, max 200' },
      },
      required: ['terminalId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const q = args.lines ? `?lines=${Number(args.lines)}` : '';
      return http('GET', `/api/agent/terminals/${encodeURIComponent(String(args.terminalId))}/tail${q}`);
    },
  },
  {
    name: 'ask_human',
    description:
      'Send a message to YOUR own Telegram chat (mother chat). The human replies as your next ' +
      'user message — this is fire-and-forget, so you should finish your turn after calling it.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    handler: async (args) => http('POST', '/api/agent/ask-human', { text: args.text }),
  },
];

async function http(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${SCUBA_URL}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return { ok: true };
  const text = await res.text();
  let json: unknown;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const errMsg = (json as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  return json;
}

async function main() {
  const server = new Server(
    { name: 'scuba', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
      };
    }
    try {
      const result = await tool.handler((req.params.arguments ?? {}) as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: (err as Error).message }],
      };
    }
  });

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error('[scuba-mcp] fatal:', err);
  process.exit(1);
});
