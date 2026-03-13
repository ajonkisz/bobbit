# Bobbit

A remote gateway for AI coding agents. Run a coding agent on a powerful machine, control it from any browser — desktop, phone, or tablet.

Bobbit wraps [pi-coding-agent](https://github.com/nickarrow/nickarrow) in a WebSocket gateway with a browser UI built on Lit. You start the server, open the URL (or scan a QR code on your phone), and interact with a coding agent that has full shell access to the host machine.

## How it works

```
┌─────────────┐         ┌──────────────────────────┐
│  Browser UI  │◄──WS──►│     Bobbit Gateway        │
│  (any device)│         │                           │
└─────────────┘         │  ┌──────────────────────┐ │
                        │  │ pi-coding-agent (RPC) │ │
                        │  │  stdin/stdout JSONL    │ │
                        │  └──────────────────────┘ │
                        └──────────────────────────┘
```

1. **Gateway** (`src/server/`) — Node.js HTTP + WebSocket server. Manages agent sessions as child processes communicating over JSONL on stdin/stdout. Serves the built UI as static files or runs headless behind a vite dev server.
2. **Browser client** (`src/app/`) — Connects to the gateway via WebSocket. Renders the chat UI using components from `src/ui/`. Supports session persistence (reconnect on refresh), multi-device access, and QR code sharing.
3. **UI components** (`src/ui/`) — Lit-based component library (forked from pi-web-ui). Message rendering, tool call visualization, model selection, settings, artifacts, and more.

## Quick start

```bash
npm install
npm run build     # compile server + bundle UI
npm start         # start gateway on :3001, serves UI
```

The gateway and Vite dev server auto-detect the NordLynx (NordVPN mesh) interface and bind to it. If NordVPN isn't running, the gateway exits with an error and Vite falls back to localhost with a warning. Open the printed URL from any device on the mesh. The auth token is printed to the terminal.

### Development (hot reload)

```bash
npm run build:server   # compile server TypeScript
npm run dev            # starts gateway + vite dev server concurrently
```

Both the gateway (`:3001`) and Vite (`:5173`) auto-bind to the NordLynx mesh IP. Vite proxies `/api` and `/ws` to the gateway. UI changes hot-reload instantly.

### CLI flags

```
bobbit [options]

--host <addr>       Bind address (default: auto-detect NordLynx mesh IP)
--port <n>          Port (default: 3001)
--cwd <dir>         Working directory for agent sessions (default: .)
--agent-cli <path>  Path to pi-coding-agent cli.js (auto-resolved from node_modules)
--static <dir>      Serve a custom UI build directory
--no-ui             Don't serve any UI (gateway-only mode)
--new-token         Force-generate a new auth token
--show-token        Print the current token and exit
```

## Architecture

### Server (`src/server/`)

| File | Purpose |
|---|---|
| `cli.ts` | Entry point. Parses args, auto-detects embedded UI at `dist/ui/`, starts the gateway. |
| `server.ts` | HTTP server with REST API routes + WebSocket upgrade handling + static file serving. |
| `agent/session-manager.ts` | Creates/destroys agent sessions. Each session is an `RpcBridge` child process + a set of connected WebSocket clients. Events are broadcast to all clients. |
| `agent/rpc-bridge.ts` | Spawns `pi-coding-agent --mode rpc` as a child process. Sends commands via JSONL on stdin, receives responses and streaming events on stdout. |
| `agent/event-buffer.ts` | Buffers recent agent events so late-joining clients can catch up. |
| `auth/token.ts` | Generates 256-bit tokens, persists to `~/.pi/gateway-token`, validates with constant-time comparison. |
| `auth/rate-limit.ts` | IP-based rate limiting for failed auth attempts. |
| `auth/oauth.ts` | OAuth flow support for provider API keys. |
| `ws/protocol.ts` | TypeScript types for the WebSocket protocol (client and server message types). |
| `ws/handler.ts` | WebSocket message handler. Authenticates the connection, then routes commands (prompt, abort, set_model, etc.) to the agent RPC bridge. |

### REST API

All routes require `Authorization: Bearer <token>`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check + session count |
| `GET` | `/api/sessions` | List active sessions |
| `POST` | `/api/sessions` | Create a new agent session |
| `GET` | `/api/sessions/:id` | Get session details |
| `DELETE` | `/api/sessions/:id` | Terminate a session |
| `GET` | `/api/connection-info` | List network addresses for multi-device access |
| `GET` | `/api/oauth/status` | OAuth provider status |
| `POST` | `/api/oauth/start` | Begin an OAuth flow |
| `POST` | `/api/oauth/complete` | Complete an OAuth flow |

### WebSocket protocol

Connect to `ws://<host>:<port>/ws/<session-id>`. First message must be `{ "type": "auth", "token": "<token>" }`. After `auth_ok`, the client can send commands and receives streaming events.

**Client → Server:** `auth`, `prompt`, `steer`, `follow_up`, `abort`, `set_model`, `compact`, `get_state`, `get_messages`, `ping`

**Server → Client:** `auth_ok`, `auth_failed`, `state`, `messages`, `event`, `session_status`, `client_joined`, `client_left`, `error`, `pong`

### Browser client (`src/app/`)

| File | Purpose |
|---|---|
| `main.ts` | App bootstrap. Gateway connection flow, session persistence (localStorage), QR code dialog for phone access, OAuth integration. |
| `remote-agent.ts` | `RemoteAgent` class — WebSocket adapter that implements the `Agent` interface expected by the UI's `ChatPanel`. Translates WebSocket events into the streaming message model. Uses a deferred-message pattern to prevent duplicate rendering of tool-call messages. |
| `custom-messages.ts` | Custom message type registration (system notifications). |
| `oauth.ts` | OAuth UI flow helpers. |

### UI components (`src/ui/`)

Forked from `@mariozechner/pi-web-ui`. Lit-based web components.

- `ChatPanel.ts` — Top-level orchestrator: wires agent, message list, input, model selector
- `components/AgentInterface.ts` — Bridges agent events to message-list + streaming-message-container
- `components/MessageList.ts` — Renders completed messages
- `components/StreamingMessageContainer.ts` — Renders in-progress streaming content
- `components/Messages.ts` — User, Assistant, Tool message renderers
- `dialogs/` — ModelSelector, Settings, Sessions, API keys, etc.
- `tools/` — Tool call renderers (Bash, artifacts, JS REPL)
- `storage/` — IndexedDB-backed persistence for sessions, settings, provider keys

## QR code / multi-device access

The QR code encodes whatever origin the browser is currently using. Since the gateway and Vite auto-bind to the NordLynx mesh IP, the QR code will contain a routable mesh address by default — scannable from any phone on the same NordVPN mesh network.

If you override `--host` to `localhost` and open via `http://localhost:...`, the QR code will point to localhost and won't work from a phone. Always open via the mesh IP printed in the startup logs.

## Security model

**This tool grants full shell access to the host machine.** The auth token is equivalent to an SSH key.

- 256-bit cryptographically random token generated on first run, persisted at `~/.pi/gateway-token` with mode `0600`
- All API routes and WebSocket connections require the token
- Constant-time token comparison prevents timing attacks
- IP-based rate limiting on failed auth attempts (automatic lockout)
- 5-second auth timeout on WebSocket connections
- Static file serving has directory traversal prevention
- Bind to a specific `--host` address to restrict network access (e.g., VPN-only interface)
- Token is passed in the URL query string for browser auto-connect — the URL itself is the credential

## Dependencies

Uses these packages from npm (not forked):
- `@mariozechner/pi-ai` — AI model abstraction (providers, streaming, tool calling)
- `@mariozechner/pi-agent-core` — Agent interface types and event model
- `@mariozechner/pi-coding-agent` — The actual coding agent (spawned as subprocess)
- `@mariozechner/mini-lit` — Minimal Lit component library (buttons, dialogs, alerts)
- `lit` — Web component framework
- `ws` — WebSocket server
- `qrcode` — QR code generation for mobile access

Forked into this repo (not npm dependencies):
- `pi-web-ui` → `src/ui/` — Chat UI components, customized for gateway use
- `pi-gateway` → `src/server/` — Gateway server, combined into same package

## Build structure

```
dist/
├── server/         # tsc output (Node16 modules)
│   └── cli.js      # bin entry point
└── ui/             # vite output (browser bundle)
    └── index.html  # SPA entry
```

Two separate TypeScript configs:
- `tsconfig.server.json` — Node16 module resolution, `src/server/` → `dist/server/`
- `tsconfig.web.json` — Bundler resolution + DOM libs, `src/ui/` + `src/app/` (bundled by vite, not emitted by tsc)
