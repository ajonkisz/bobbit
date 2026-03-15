# Bobbit — Agent Guide

## What is this?

A remote gateway for AI coding agents. Wraps pi-coding-agent in a WebSocket server with a browser-based chat UI. The user runs `bobbit` on a dev machine and interacts with the agent from any browser.

## Repo layout

```
src/
├── server/          # Node.js gateway (HTTP + WebSocket + child process management)
│   ├── cli.ts       # Entry point, arg parsing, NordLynx detection, system prompt resolution
│   ├── server.ts    # HTTP server, REST API, static serving, WS upgrade
│   ├── harness.ts   # Dev server wrapper (watches sentinel file, auto-restarts)
│   ├── harness-signal.ts  # Touches sentinel to trigger harness restart
│   ├── agent/       # Session lifecycle, RPC bridge, persistence, title generation
│   │   ├── session-manager.ts  # Create/destroy/restore sessions, broadcast events
│   │   ├── session-store.ts    # Disk persistence (~/.pi/gateway-sessions.json)
│   │   ├── rpc-bridge.ts       # JSONL stdin/stdout bridge to agent subprocess
│   │   ├── event-buffer.ts     # Buffer events for late-joining clients
│   │   └── title-generator.ts  # Auto-generate session titles via Claude Haiku
│   ├── auth/        # Token auth, rate limiting, OAuth
│   └── ws/          # WebSocket protocol types and message handler
├── ui/              # Lit web components (forked from pi-web-ui, NOT an npm dep)
│   ├── ChatPanel.ts # Top-level UI orchestrator
│   ├── components/  # MessageList, StreamingMessageContainer, AgentInterface, etc.
│   ├── dialogs/     # ModelSelector, Settings, Sessions
│   ├── tools/       # Tool call renderers (Bash, Read, Write, Edit, Grep, Find, Ls)
│   └── storage/     # IndexedDB persistence
├── app/             # Browser entry point (connects to gateway)
│   ├── main.ts      # Bootstrap, routing, session sidebar, QR code, OAuth
│   └── remote-agent.ts  # WebSocket ↔ Agent interface adapter (critical file)
└── config/
    └── system-prompt.md  # Custom system prompt for agent sessions
```

## Commands

```bash
npm run build          # Full build (server + UI)
npm run build:server   # Compile server TypeScript only
npm run build:ui       # Vite bundle UI only
npm run dev            # Gateway + vite dev server with hot reload
npm run dev:harness    # Gateway via restart harness + vite (use this for development)
npm run restart-server # Signal the harness to rebuild & restart the server
npm start              # Run built gateway (serves embedded UI)
npm run check          # Type-check both server and web without emitting
npm test               # Mobile header Playwright tests
npm run test:e2e       # E2E tests (requires running gateway + vite)
```

### Dev server harness

When developing Bobbit itself, use `npm run dev:harness` instead of `npm run dev`. The harness wraps the server process and watches a sentinel file (`~/.pi/gateway-restart`). When an agent finishes making server-side changes, it runs `npm run restart-server` to trigger:

1. Kill the running server
2. Wait for the port to clear
3. `npm run build:server` to recompile TypeScript
4. Relaunch the server

The harness also auto-restarts on unexpected crashes. Sessions survive restarts thanks to disk persistence (`~/.pi/gateway-sessions.json`).

## Key concepts

- **Session**: A running pi-coding-agent child process, managed by SessionManager. Multiple WebSocket clients can connect to one session. Sessions persist to disk and restore on server restart.
- **Session persistence**: Metadata (id, title, cwd, agent session file) stored in `~/.pi/gateway-sessions.json`. On restart, `restoreSessions()` re-spawns agents and uses `switch_session` RPC to resume from the agent's `.jsonl` file.
- **Auto-titles**: After the first agent turn, `title-generator.ts` sends the conversation to Claude Haiku for a 2-3 word summary. Falls back silently if auth is unavailable.
- **RPC Bridge**: JSONL over stdin/stdout to the agent subprocess. Commands in, events out.
- **RemoteAgent** (`src/app/remote-agent.ts`): Browser-side WebSocket client that duck-types the Agent interface so ChatPanel can use it like a local agent. This is the most complex file — handles streaming message state, deferred tool-call messages to prevent duplicate rendering, and session reconnection.
- **Deferred assistant messages**: Tool-call assistant messages are held in `_deferredAssistantMessage` instead of going straight into `messages[]`. The streaming container shows them live. They flush to `messages[]` when the next message starts. This prevents both message-list and streaming-container from rendering the same content.
- **System prompt assembly**: Each session's system prompt is assembled from three layers (in order): (1) global `config/system-prompt.md`, (2) `AGENTS.md` from the session's working directory, (3) goal spec. The `AGENTS.md` supports `@FILENAME.md` syntax — lines matching `@somefile.md` are replaced inline with the referenced file's contents (resolved relative to the file's directory, recursive, with circular reference protection). The assembled prompt is written to `~/.pi/session-prompts/{sessionId}.md` and passed to the agent via `--system-prompt`.

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
- **Gateway and Vite auto-detect the NordLynx mesh IP** and bind to it. If NordVPN isn't running, the gateway exits with an error. Pass `--host <addr>` to override. Never bind to `0.0.0.0` — restrict access to the mesh network only.

## QR code / multi-device access

The QR code dialog (`src/app/main.ts` `showQrCodeDialog()`) encodes `window.location.origin` + the auth token. Since both the gateway and Vite auto-detect and bind to the NordLynx mesh IP, the QR code will contain a routable mesh address by default. The startup logs print the full URL with the token — users can copy-paste or scan from any device on the mesh.

## Development workflow

See [docs/dev-workflow.md](docs/dev-workflow.md) for the full guide on running modes, when to restart the server, and how to make changes safely.

**Quick reference**: UI changes (`src/ui/`, `src/app/`) hot-reload automatically. Server changes (`src/server/`) require `npm run restart-server` to rebuild and restart. Always run `npm run check` to verify types before triggering a restart.

## Common tasks

**Add a new REST endpoint**: Edit `src/server/server.ts` `handleApiRoute()`.

**Add a new WebSocket command**: Add to `ClientMessage` union in `src/server/ws/protocol.ts`, handle in `src/server/ws/handler.ts` switch, add convenience method on `RpcBridge` if it maps to an agent command.

**Add a new UI component**: Add to `src/ui/components/`, export from `src/ui/index.ts`.

**Add a new tool renderer**: Create in `src/ui/tools/renderers/`, register in `src/ui/tools/index.ts`.

**Change how messages render**: `src/ui/components/Messages.ts` for standard roles, `src/ui/components/message-renderer-registry.ts` for custom types.

**Debug duplicate messages**: The deferred message pattern in `remote-agent.ts` is subtle. `message-list` renders `state.messages` (completed), `streaming-message-container` renders `state.streamMessage` (in-progress). They must never show the same message. Tool-call messages stay in streaming until the next message starts.

**Debug session persistence**: Check `~/.pi/gateway-sessions.json` for persisted session data. Sessions restore on startup via `session-manager.ts` `restoreSessions()`. If an agent's `.jsonl` session file is missing, that session is skipped.
