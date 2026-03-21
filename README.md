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

See [docs/dev-workflow.md](docs/dev-workflow.md) for the full development workflow, including when to restart the server and how agents should make changes.

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

## Repo layout

```
src/
├── server/          # Node.js gateway (HTTP + WebSocket + child process management)
│   ├── cli.ts       # Entry point, arg parsing, NordLynx detection, TLS setup
│   ├── server.ts    # HTTP server, REST API, static serving, WS upgrade
│   ├── harness.ts   # Dev server wrapper (watches sentinel file, auto-restarts)
│   ├── harness-signal.ts  # Touches sentinel to trigger harness restart
│   ├── index.ts     # Barrel export for server public API
│   ├── pi-dir.ts    # Central ~/.pi directory resolution (overridable for tests)
│   ├── agent/       # Session lifecycle, RPC bridge, persistence, goals, teams
│   │   ├── artifact-spec-assistant.ts  # System prompt for artifact spec assistant
│   │   ├── artifact-spec-manager.ts    # Artifact spec CRUD operations
│   │   ├── artifact-spec-store.ts      # Artifact spec persistence (artifact-specs/*.yaml)
│   │   ├── assistant-registry.ts       # Registry of assistant types (goal, role, tool, spec)
│   │   ├── color-store.ts              # Per-session color index (~/.pi/gateway-session-colors.json)
│   │   ├── cost-tracker.ts             # Per-session cost tracking (~/.pi/gateway-session-costs.json)
│   │   ├── event-buffer.ts             # Circular buffer for event replay on reconnect
│   │   ├── goal-artifact-store.ts      # Goal artifact storage (~/.pi/gateway-goal-artifacts.json)
│   │   ├── goal-assistant.ts           # System prompt for goal creation assistant
│   │   ├── goal-manager.ts             # Goal CRUD operations
│   │   ├── goal-store.ts               # Goal persistence (~/.pi/gateway-goals.json)
│   │   ├── name-generator.ts           # Role-themed name generation for team agents
│   │   ├── prompt-queue.ts             # Server-side prompt queue per session
│   │   ├── role-assistant.ts           # System prompt for role assistant
│   │   ├── role-manager.ts             # Role definitions, tool access, management
│   │   ├── role-store.ts               # Role persistence (roles/*.yaml)
│   │   ├── rpc-bridge.ts               # JSONL stdin/stdout bridge to agent subprocess
│   │   ├── session-manager.ts          # Create/destroy/restore sessions, broadcast events
│   │   ├── session-store.ts            # Session persistence (~/.pi/gateway-sessions.json)
│   │   ├── system-prompt.ts            # Assemble system prompt from layers
│   │   ├── task-manager.ts             # Task CRUD and state transitions
│   │   ├── task-store.ts               # Task persistence (~/.pi/gateway-tasks.json)
│   │   ├── team-manager.ts             # Team lifecycle (spawn/dismiss agents)
│   │   ├── team-names.ts               # Random name generator for team agents
│   │   ├── team-store.ts               # Team state persistence (~/.pi/gateway-team-state.json)
│   │   ├── title-generator.ts          # Auto-generate session titles via Claude Haiku
│   │   ├── tool-assistant.ts           # System prompt for tool management assistant
│   │   ├── tool-manager.ts             # Tool metadata layering (built-in + overrides)
│   │   ├── tool-store.ts               # Tool metadata persistence (~/.pi/gateway-tools.json)
│   │   ├── trait-manager.ts            # Trait CRUD operations
│   │   └── trait-store.ts              # Trait persistence (traits/*.yaml)
│   ├── auth/        # Token auth, rate limiting, TLS, OAuth, DNS
│   │   ├── desec.ts       # deSEC dynamic DNS integration
│   │   ├── oauth.ts       # OAuth flow (start, complete, status)
│   │   ├── rate-limit.ts  # IP-based rate limiting for auth failures
│   │   ├── tls.ts         # Self-signed TLS certificate generation (~/.pi/gateway-tls/)
│   │   └── token.ts       # Load/create/validate auth tokens (~/.pi/gateway-token)
│   ├── ws/          # WebSocket protocol types and message handler
│   │   ├── handler.ts    # Auth handshake, command routing, skill dispatch
│   │   └── protocol.ts   # ClientMessage / ServerMessage type unions
│   └── skills/      # Reusable skill definitions with isolated sub-agent execution
│       ├── definitions-sync.ts  # Export definitions to ~/.pi/skill-definitions.json
│       ├── git.ts               # Git worktree helpers
│       ├── index.ts             # Barrel export + auto-registration of built-in skills
│       ├── registry.ts          # In-memory skill definition registry
│       ├── sub-agent.ts         # Spawn isolated agent subprocesses for skill execution
│       ├── types.ts             # Skill interface
│       └── definitions/         # Built-in skill templates
│           ├── code-review.ts       # Correctness, security, and design review skills
│           └── test-suite-report.ts # Test suite analysis skill
├── ui/              # Lit web components (forked from pi-web-ui, NOT an npm dep)
│   ├── ChatPanel.ts # Top-level UI orchestrator
│   ├── app.css      # Global app styles
│   ├── index.ts     # Barrel export
│   ├── speech-recognition.d.ts  # Web Speech API type declarations
│   ├── components/  # MessageList, StreamingMessageContainer, AgentInterface, etc.
│   │   ├── AgentInterface.ts              # Bridges agent events to UI state
│   │   ├── AttachmentTile.ts              # File attachment display tile
│   │   ├── ConsoleBlock.ts                # Console output block
│   │   ├── CustomProviderCard.ts          # Custom AI provider card
│   │   ├── DiffBlock.ts                   # Diff display block
│   │   ├── ErrorMessage.ts                # Error message display
│   │   ├── ExpandableSection.ts           # Collapsible section wrapper
│   │   ├── GitStatusWidget.ts             # Git status indicator
│   │   ├── Input.ts                       # Chat input with attachments
│   │   ├── LiveTimer.ts                   # Live elapsed-time timer
│   │   ├── MessageEditor.ts               # Inline message editing
│   │   ├── MessageList.ts                 # Renders state.messages (completed messages)
│   │   ├── Messages.ts                    # Message rendering by role
│   │   ├── ProviderKeyInput.ts            # API key input field
│   │   ├── SandboxedIframe.ts             # Sandboxed iframe container
│   │   ├── StreamingMessageContainer.ts   # Renders state.streamMessage (in-progress)
│   │   ├── ThinkingBlock.ts               # Agent thinking display
│   │   ├── ToolGroup.ts                   # Tool call grouping
│   │   ├── message-renderer-registry.ts   # Custom message type renderers
│   │   └── sandbox/                       # Sandboxed iframe runtime providers
│   │       ├── ArtifactsRuntimeProvider.ts
│   │       ├── AttachmentsRuntimeProvider.ts
│   │       ├── ConsoleRuntimeProvider.ts
│   │       ├── FileDownloadRuntimeProvider.ts
│   │       ├── RuntimeMessageBridge.ts
│   │       ├── RuntimeMessageRouter.ts
│   │       └── SandboxRuntimeProvider.ts
│   ├── dialogs/     # ModelSelector, Settings, Sessions, AttachmentOverlay
│   │   ├── ApiKeyPromptDialog.ts
│   │   ├── AttachmentOverlay.ts
│   │   ├── CustomProviderDialog.ts
│   │   ├── ModelSelector.ts
│   │   ├── PersistentStorageDialog.ts
│   │   ├── ProvidersModelsTab.ts
│   │   ├── SessionListDialog.ts
│   │   └── SettingsDialog.ts
│   ├── prompts/
│   │   └── prompts.ts    # Default prompt templates
│   ├── tools/       # Tool call renderers
│   │   ├── extract-document.ts    # Document text extraction
│   │   ├── index.ts               # Tool renderer registration
│   │   ├── javascript-repl.ts     # JavaScript REPL support
│   │   ├── renderer-registry.ts   # Tool name → renderer mapping
│   │   ├── types.ts               # Tool renderer type definitions
│   │   ├── renderers/             # Per-tool renderers
│   │   │   ├── ArtifactToolRenderers.ts
│   │   │   ├── BashRenderer.ts
│   │   │   ├── BrowserClickRenderer.ts
│   │   │   ├── BrowserEvalRenderer.ts
│   │   │   ├── BrowserNavigateRenderer.ts
│   │   │   ├── BrowserTypeRenderer.ts
│   │   │   ├── BrowserWaitRenderer.ts
│   │   │   ├── CalculateRenderer.ts
│   │   │   ├── DefaultRenderer.ts
│   │   │   ├── DelegateRenderer.ts
│   │   │   ├── EditRenderer.ts
│   │   │   ├── FindRenderer.ts
│   │   │   ├── GetCurrentTimeRenderer.ts
│   │   │   ├── GrepRenderer.ts
│   │   │   ├── HtmlRenderer.ts
│   │   │   ├── LsRenderer.ts
│   │   │   ├── ReadRenderer.ts
│   │   │   ├── ScreenshotRenderer.ts
│   │   │   ├── SvgRenderer.ts
│   │   │   ├── TaskToolRenderers.ts
│   │   │   ├── TeamToolRenderers.ts
│   │   │   ├── WebFetchRenderer.ts
│   │   │   ├── WebSearchRenderer.ts
│   │   │   ├── WriteRenderer.ts
│   │   │   ├── delegate-cards.ts
│   │   │   └── image-utils.ts
│   │   └── artifacts/             # Artifact display
│   │       ├── ArtifactElement.ts
│   │       ├── ArtifactPill.ts
│   │       ├── Console.ts
│   │       ├── DocxArtifact.ts
│   │       ├── ExcelArtifact.ts
│   │       ├── GenericArtifact.ts
│   │       ├── HtmlArtifact.ts
│   │       ├── ImageArtifact.ts
│   │       ├── MarkdownArtifact.ts
│   │       ├── PdfArtifact.ts
│   │       ├── SvgArtifact.ts
│   │       ├── TextArtifact.ts
│   │       ├── artifacts-tool-renderer.ts
│   │       ├── artifacts.ts
│   │       └── index.ts
│   ├── storage/     # IndexedDB persistence
│   │   ├── app-storage.ts                    # App storage manager
│   │   ├── store.ts                          # Base store class
│   │   ├── types.ts                          # Storage type definitions
│   │   ├── backends/
│   │   │   └── indexeddb-storage-backend.ts   # IndexedDB backend
│   │   └── stores/
│   │       ├── command-history-store.ts
│   │       ├── custom-providers-store.ts
│   │       ├── goal-draft-store.ts
│   │       ├── provider-keys-store.ts
│   │       ├── role-draft-store.ts
│   │       ├── sessions-store.ts
│   │       ├── settings-store.ts
│   │       └── spec-draft-store.ts
│   └── utils/       # Formatting, auth token, model discovery, i18n
│       ├── ansi.ts
│       ├── attachment-utils.ts
│       ├── auth-token.ts
│       ├── format.ts
│       ├── i18n.ts
│       ├── model-discovery.ts
│       ├── proxy-utils.ts
│       └── test-sessions.ts
├── app/             # Browser entry point (connects to gateway)
│   ├── api.ts                  # Gateway REST API client
│   ├── app.css                 # App-level styles
│   ├── artifact-spec-page.ts   # Artifact spec management page
│   ├── artifact-spec.css       # Artifact spec page styles
│   ├── custom-messages.ts      # Custom message type definitions
│   ├── cwd-combobox.ts         # Working directory combobox
│   ├── dialogs.ts              # Dialog helpers
│   ├── goal-dashboard.ts       # Goal dashboard page
│   ├── goal-dashboard.css      # Goal dashboard styles
│   ├── main.ts                 # Bootstrap, routing, session sidebar, QR code
│   ├── mobile-header.ts        # Mobile-responsive header
│   ├── oauth.ts                # Browser-side OAuth flow
│   ├── preview-panel.ts        # Live preview panel
│   ├── proposal-parsers.ts     # Goal/role/spec proposal parsing
│   ├── qrcode.d.ts             # QR code library type declarations
│   ├── remote-agent.ts         # WebSocket ↔ Agent interface adapter
│   ├── render-helpers.ts       # Rendering utility functions
│   ├── render.ts               # Top-level render orchestration
│   ├── role-manager-dialog.ts  # Role creation/editing dialog
│   ├── role-manager-page.ts    # Role management page
│   ├── role-manager.css        # Role manager page styles
│   ├── routing.ts              # Hash-based client routing
│   ├── session-colors.ts       # Session color assignment
│   ├── session-manager.ts      # Client-side session management
│   ├── sidebar.ts              # Desktop session sidebar
│   ├── state.ts                # Client-side app state
│   ├── storage.ts              # Client-side storage helpers
│   ├── tool-manager-page.ts    # Tool management page
│   └── tool-manager.css        # Tool manager page styles
├── config/
│   └── system-prompt.md  # Custom system prompt for agent sessions
└── docs/
    ├── bobbit-sprites.md  # Bobbit pixel art, animation & accessory system reference
    ├── dev-workflow.md    # Development workflow guide
    └── prompt-queue.md    # Prompt queue architecture
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

## Prompt queue & message dispatch

User messages are routed through a server-side prompt queue that handles queuing when the agent is busy, priority sorting for steered (interrupt) messages, and automatic draining when the agent finishes a turn. The client renders user messages optimistically and deduplicates against server echoes. See [docs/prompt-queue.md](docs/prompt-queue.md) for the full architecture.

## System prompt

Each agent session's system prompt is assembled from three layers, in order:

1. **Global system prompt** — `config/system-prompt.md` in the Bobbit project root. Applies to all sessions. Good for tone, output style, or global rules.
2. **AGENTS.md** — If the session's working directory contains an `AGENTS.md` file, its contents are included under a "Project Context" heading. This is the per-project context file — describe the codebase, conventions, and constraints here.
3. **Goal spec** — If the session belongs to a goal, the goal's markdown spec is appended under a "Goal" heading with the goal title and status.

### `@FILENAME.md` references

`AGENTS.md` (and any file it references) supports inline file inclusion. A line containing only `@somefile.md` is replaced with the contents of that file, resolved relative to the referencing file's directory. References are resolved recursively. Circular references are detected and replaced with a comment.

```markdown
# My Project

@docs/architecture.md
@docs/conventions.md

## Quick notes
- Use TypeScript strict mode
```

This lets you split project context across multiple files while keeping a single entry point. Files that are *not* inlined via `@` are still available on disk for the agent to read with its tools when needed.

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
