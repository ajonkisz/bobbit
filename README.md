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

1. **Gateway** (`src/server/`) — Node.js HTTP + WebSocket server. Manages agent sessions as child processes communicating over JSONL on stdin/stdout. Sessions persist to disk and survive server restarts. Serves the built UI as static files or runs headless behind a vite dev server.
2. **Browser client** (`src/app/`) — Connects to the gateway via WebSocket. Renders the chat UI using components from `src/ui/`. Desktop layout has a session sidebar; mobile has a landing page with session cards. Supports multi-device access and QR code sharing.
3. **UI components** (`src/ui/`) — Lit-based component library (forked from pi-web-ui). Message rendering, specialized tool call renderers (bash, read, write, edit, grep, find, ls), model selection, settings, and more.

## Quick start

```bash
npm install
npm run build     # compile server + bundle UI
npm start         # start gateway on :3001, serves UI
```

The gateway auto-detects the NordLynx (NordVPN mesh) interface and binds to it. If NordVPN isn't running, the gateway exits with an error. Open the printed URL from any device on the mesh. The auth token is printed to the terminal.

### Development

```bash
npm run build:server   # compile server TypeScript (required before first run)
npm run dev            # starts gateway + vite dev server concurrently
npm run dev:harness    # same, but with auto-restart harness (recommended)
```

Both the gateway (`:3001`) and Vite (`:5173`) auto-bind to the NordLynx mesh IP. Vite proxies `/api` and `/ws` to the gateway. UI changes hot-reload instantly.

### Dev server harness

Use `npm run dev:harness` when developing Bobbit itself. The harness wraps the server process and watches a sentinel file (`~/.pi/gateway-restart`). When an agent finishes making server-side changes, it runs `npm run restart-server` to:

1. Kill the running server
2. Wait for the port to clear
3. Run `npm run build:server` to recompile TypeScript
4. Relaunch the server

The harness also auto-restarts on unexpected crashes. Sessions survive restarts thanks to disk persistence.

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
| `cli.ts` | Entry point. Parses args, auto-detects NordLynx IP and embedded UI, resolves custom system prompt from `config/system-prompt.md`, starts the gateway. |
| `server.ts` | HTTP server with REST API routes + WebSocket upgrade handling + static file serving. |
| `harness.ts` | Dev server wrapper. Watches sentinel file for restart signals, auto-restarts on crash. |
| `harness-signal.ts` | Touches the sentinel file to trigger a harness restart. |
| `agent/session-manager.ts` | Creates/destroys/restores agent sessions. Manages RPC bridge lifecycle, client connections, auto-title generation, and disk persistence. |
| `agent/session-store.ts` | Persists session metadata to `~/.pi/gateway-sessions.json`. Sessions restore on server restart via `switch_session` RPC. |
| `agent/rpc-bridge.ts` | Spawns `pi-coding-agent --mode rpc` as a child process. Sends commands via JSONL on stdin, receives responses and streaming events on stdout. |
| `agent/event-buffer.ts` | Buffers recent agent events so late-joining clients can catch up. |
| `agent/title-generator.ts` | Auto-generates 2-3 word session titles via Claude Haiku after the first agent turn. Falls back silently if auth is unavailable. |
| `auth/token.ts` | Generates 256-bit tokens, persists to `~/.pi/gateway-token`, validates with constant-time comparison. |
| `auth/rate-limit.ts` | IP-based rate limiting for failed auth attempts. |
| `auth/oauth.ts` | OAuth flow support for provider API keys. |
| `ws/protocol.ts` | TypeScript types for the WebSocket protocol (client and server message types). |
| `ws/handler.ts` | WebSocket message handler. Authenticates the connection, then routes commands to the agent RPC bridge. |

### REST API

All routes require `Authorization: Bearer <token>`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check + session count |
| `GET` | `/api/sessions` | List active sessions (includes title, status, client count) |
| `POST` | `/api/sessions` | Create a new agent session |
| `GET` | `/api/sessions/:id` | Get session details |
| `DELETE` | `/api/sessions/:id` | Terminate a session |
| `PUT` | `/api/sessions/:id/title` | Rename a session |
| `GET` | `/api/connection-info` | List network addresses for multi-device access |
| `GET` | `/api/oauth/status` | OAuth provider status |
| `POST` | `/api/oauth/start` | Begin an OAuth flow |
| `POST` | `/api/oauth/complete` | Complete an OAuth flow |

### WebSocket protocol

Connect to `ws://<host>:<port>/ws/<session-id>`. First message must be `{ "type": "auth", "token": "<token>" }`. After `auth_ok`, the client can send commands and receives streaming events.

**Client → Server:** `auth`, `prompt`, `steer`, `follow_up`, `abort`, `set_model`, `compact`, `get_state`, `get_messages`, `set_title`, `generate_title`, `ping`

**Server → Client:** `auth_ok`, `auth_failed`, `state`, `messages`, `event`, `session_status`, `session_title`, `client_joined`, `client_left`, `error`, `pong`

### Browser client (`src/app/`)

| File | Purpose |
|---|---|
| `main.ts` | App bootstrap. Hash-based routing (`#/` landing, `#/session/{id}` connected). Desktop sidebar + mobile landing page. Session management (create, connect, rename, terminate). Model/thinking selectors in header. QR code dialog, OAuth integration. |
| `remote-agent.ts` | `RemoteAgent` class — WebSocket adapter that implements the `Agent` interface expected by the UI's `ChatPanel`. Translates WebSocket events into the streaming message model. Uses a deferred-message pattern to prevent duplicate rendering of tool-call messages. Handles `session_title` events for live title updates. |
| `custom-messages.ts` | Custom message type registration (system notifications). |
| `oauth.ts` | OAuth UI flow helpers. |

### UI components (`src/ui/`)

Forked from `@mariozechner/pi-web-ui`. Lit-based web components.

- `ChatPanel.ts` — Top-level orchestrator: wires agent, message list, input, model selector
- `components/AgentInterface.ts` — Bridges agent events to message-list + streaming-message-container, context window usage bar
- `components/MessageList.ts` — Renders completed messages
- `components/StreamingMessageContainer.ts` — Renders in-progress streaming content
- `components/Messages.ts` — User, Assistant, Tool message renderers
- `components/MessageEditor.ts` — Inline message editing
- `dialogs/` — ModelSelector, Settings, Sessions, API keys, etc.
- `tools/renderers/` — Specialized renderers for Bash, Read, Write, Edit, Grep, Find, Ls tool calls
- `storage/` — IndexedDB-backed persistence for sessions, settings, provider keys

## Session management

Sessions are the core abstraction. Each session is a running `pi-coding-agent` child process with its own conversation history.

- **Persistence**: Session metadata (id, title, cwd, agent session file path) persists to `~/.pi/gateway-sessions.json`. On server restart, sessions are restored by re-spawning agent processes and using the `switch_session` RPC command to resume from the agent's `.jsonl` session file.
- **Auto-titles**: After the first agent turn completes, the gateway sends the conversation to Claude Haiku to generate a 2-3 word summary title (e.g. "Fix Login Bug", "Redis Setup"). Uses OAuth or API key auth from `~/.pi/agent/auth.json`. Falls back silently if unavailable.
- **Manual rename**: Sessions can be renamed via the UI (pencil icon) or the `PUT /api/sessions/:id/title` endpoint.
- **Multi-device**: Multiple browser tabs/devices can connect to the same session. Events are broadcast to all clients.

## Custom system prompt

Place a `config/system-prompt.md` file in the project root to customize agent behavior. The CLI auto-detects it and passes it to the agent subprocess via `--system-prompt`. This is useful for setting tone, output style, or project-specific instructions.

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
- Gateway auto-binds to the NordLynx mesh IP — never `0.0.0.0`. Pass `--host` to override.
- Token is passed in the URL query string for browser auto-connect — the URL itself is the credential

## Testing

```bash
npm test              # Mobile header unit tests (Playwright)
npm run test:e2e      # E2E tests (requires running gateway + vite)
```

E2E tests require a separate gateway and Vite instance running on localhost. See `tests/playwright-e2e.config.ts` for setup details.

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
│   ├── cli.js      # bin entry point
│   ├── harness.js  # dev server wrapper
│   └── agent/      # session manager, rpc bridge, title generator, store
└── ui/             # vite output (browser bundle)
    └── index.html  # SPA entry
```

Two separate TypeScript configs:
- `tsconfig.server.json` — Node16 module resolution, `src/server/` → `dist/server/`
- `tsconfig.web.json` — Bundler resolution + DOM libs, `src/ui/` + `src/app/` (bundled by vite, not emitted by tsc)
