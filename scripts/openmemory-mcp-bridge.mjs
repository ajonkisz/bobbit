#!/usr/bin/env node
/**
 * Minimal stdio MCP server that bridges to OpenMemory's REST API.
 * Replaces the broken mcp-remote SSE bridge with reliable stateless HTTP calls.
 *
 * Env vars:
 *   OPENMEMORY_URL  — base URL (default: http://localhost:8765)
 *   OPENMEMORY_USER — user_id for scoping (default: aj)
 */

import { createInterface } from 'node:readline';

const BASE_URL = process.env.OPENMEMORY_URL || 'http://localhost:8765';
const USER_ID = process.env.OPENMEMORY_USER || 'aj';

// ── Tool definitions ─────────────────────────────────────────────

const TOOLS = [
  {
    name: 'search_memory',
    description: 'Search memories using a natural language query. Returns relevant memories from past agent sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'add_memories',
    description: 'Store a new memory. Use infer=true to let the LLM extract discrete facts from the text, or false to store verbatim.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text content to memorize' },
        infer: { type: 'boolean', description: 'If true, LLM extracts facts from text. If false, stores verbatim.', default: true },
      },
      required: ['text'],
    },
  },
  {
    name: 'list_memories',
    description: 'List all stored memories, optionally filtered by category.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Optional category filter' },
      },
    },
  },
  {
    name: 'delete_memories',
    description: 'Delete a specific memory by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'The ID of the memory to delete' },
      },
      required: ['memory_id'],
    },
  },
];

// ── REST API helpers ─────────────────────────────────────────────

async function apiGet(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function apiDelete(path) {
  const res = await fetch(`${BASE_URL}${path}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`DELETE ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── Tool handlers ────────────────────────────────────────────────

async function handleToolCall(name, args) {
  switch (name) {
    case 'search_memory': {
      const data = await apiPost('/api/v1/memories/filter', {
        user_id: USER_ID,
        search_query: args.query || '',
        size: 20,
      });
      const memories = (data.items || []).map(m =>
        `[${m.id}] ${m.content || ''}`
      );
      return memories.length > 0
        ? memories.join('\n\n')
        : 'No memories found matching the query.';
    }

    case 'add_memories': {
      const data = await apiPost('/api/v1/memories/', {
        user_id: USER_ID,
        text: args.text,
        infer: args.infer !== false,
        app: 'bobbit',
      });
      return `Memory stored successfully. ID: ${data.id || 'created'}`;
    }

    case 'list_memories': {
      const body = { user_id: USER_ID, size: 50 };
      if (args.category) body.category_ids = [args.category];
      const data = await apiPost('/api/v1/memories/filter', body);
      const memories = (data.items || []).map(m => {
        const cats = (m.categories || []).map(c => c.name || c).join(', ') || 'uncategorized';
        return `[${m.id}] (${cats}) ${m.content || ''}`;
      });
      return memories.length > 0
        ? `${data.total} memories total:\n\n${memories.join('\n\n')}`
        : 'No memories stored yet.';
    }

    case 'delete_memories': {
      await apiDelete(`/api/v1/memories/${args.memory_id}`);
      return `Memory ${args.memory_id} deleted.`;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── JSON-RPC stdio transport ─────────────────────────────────────

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleMessage(msg) {
  // Notifications (no id) — ignore
  if (msg.id == null) return;

  try {
    switch (msg.method) {
      case 'initialize':
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'OpenMemory REST Bridge', version: '1.0.0' },
          },
        });
        break;

      case 'tools/list':
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { tools: TOOLS },
        });
        break;

      case 'tools/call': {
        const { name, arguments: args } = msg.params;
        try {
          const text = await handleToolCall(name, args || {});
          send({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text }] },
          });
        } catch (err) {
          send({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true },
          });
        }
        break;
      }

      default:
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        });
    }
  } catch (err) {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32603, message: err.message },
    });
  }
}

// ── Main ─────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    handleMessage(msg);
  } catch {
    // Ignore unparseable lines
  }
});

process.stderr.write('[openmemory-bridge] Started — REST bridge to ' + BASE_URL + '\n');
