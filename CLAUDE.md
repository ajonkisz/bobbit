# Bobbit — Agent Guide

## What is this?

A remote gateway for AI coding agents. Wraps pi-coding-agent in a WebSocket server with a browser-based chat UI. The user runs `bobbit` on a dev machine and interacts with the agent from any browser.

## Repo layout

```
src/
├── server/          # Node.js gateway (HTTP + WebSocket + child process management)
│   ├── cli.ts       # Entry point & arg parsing
│   ├── server.ts    # HTTP server, REST API, static serving, WS upgrade
│   ├── agent/       # Session lifecycle, RPC bridge to pi-coding-agent subprocess
│   ├── auth/        # Token auth, rate limiting, OAuth
│   └── ws/          # WebSocket protocol types and message handler
├── ui/              # Lit web components (forked from pi-web-ui, NOT an npm dep)
│   ├── ChatPanel.ts # Top-level UI orchestrator
│   ├── components/  # MessageList, StreamingMessageContainer, AgentInterface, etc.
│   ├── dialogs/     # ModelSelector, Settings, Sessions
│   ├── tools/       # Tool call renderers (Bash, artifacts)
│   └── storage/     # IndexedDB persistence
└── app/             # Browser entry point (connects to gateway)
    ├── main.ts      # Bootstrap, session persistence, QR code, OAuth
    └── remote-agent.ts  # WebSocket ↔ Agent interface adapter (critical file)
```

## Commands

```bash
npm run build          # Full build (server + UI)
npm run build:server   # Compile server TypeScript only
npm run build:ui       # Vite bundle UI only
npm run dev            # Gateway + vite dev server with hot reload
npm start              # Run built gateway (serves embedded UI)
npm run check          # Type-check both server and web without emitting
```

## Key concepts

- **Session**: A running pi-coding-agent child process, managed by SessionManager. Multiple WebSocket clients can connect to one session.
- **RPC Bridge**: JSONL over stdin/stdout to the agent subprocess. Commands in, events out.
- **RemoteAgent** (`src/app/remote-agent.ts`): Browser-side WebSocket client that duck-types the Agent interface so ChatPanel can use it like a local agent. This is the most complex file — handles streaming message state, deferred tool-call messages to prevent duplicate rendering, and session reconnection.
- **Deferred assistant messages**: Tool-call assistant messages are held in `_deferredAssistantMessage` instead of going straight into `messages[]`. The streaming container shows them live. They flush to `messages[]` when the next message starts. This prevents both message-list and streaming-container from rendering the same content.

## Dual TypeScript configs

- `tsconfig.server.json`: Node16 modules, targets `src/server/`, emits to `dist/server/`
- `tsconfig.web.json`: Bundler resolution + DOM libs, covers `src/ui/` + `src/app/` (vite bundles these, tsc only type-checks)

## npm dependencies vs forked code

**From npm** (do not modify, update via npm): `pi-ai`, `pi-agent-core`, `pi-coding-agent`, `mini-lit`, `lit`, `ws`

**Forked into repo** (our code, modify freely):
- `src/ui/` ← was `@mariozechner/pi-web-ui`
- `src/server/` ← was `@mariozechner/pi-gateway`

If you need to change UI components or server behavior, edit the forked code directly. If you need changes to the agent itself (tool definitions, LLM interaction, etc.), those live in the npm packages upstream.

## Security notes

- Auth token at `~/.pi/gateway-token` (256-bit, mode 0600)
- All API + WS require token. Constant-time comparison. Rate limiting on failures.
- **The token grants full shell access.** Treat it like an SSH private key.
- Static file serving has traversal guard.
- Bind `--host` to restrict network interfaces.

## Common tasks

**Add a new REST endpoint**: Edit `src/server/server.ts` `handleApiRoute()`.

**Add a new WebSocket command**: Add to `ClientMessage` union in `src/server/ws/protocol.ts`, handle in `src/server/ws/handler.ts` switch, add convenience method on `RpcBridge` if it maps to an agent command.

**Add a new UI component**: Add to `src/ui/components/`, export from `src/ui/index.ts`.

**Change how messages render**: `src/ui/components/Messages.ts` for standard roles, `src/ui/components/message-renderer-registry.ts` for custom types.

**Debug duplicate messages**: The deferred message pattern in `remote-agent.ts` is subtle. `message-list` renders `state.messages` (completed), `streaming-message-container` renders `state.streamMessage` (in-progress). They must never show the same message. Tool-call messages stay in streaming until the next message starts.
