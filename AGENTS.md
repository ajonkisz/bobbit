# Bobbit — Agent Guide

## What is this?

A remote gateway for AI coding agents. Wraps pi-coding-agent in a WebSocket server with a browser-based chat UI. The user runs `bobbit` on a dev machine and interacts with the agent from any browser.

## Repo layout

```
src/
├── server/          # Node.js gateway (HTTP + WebSocket + child process management)
│   ├── cli.ts       # Entry point, arg parsing, NordLynx detection, TLS setup, system prompt resolution
│   ├── server.ts    # HTTP server, REST API, static serving, WS upgrade
│   ├── harness.ts   # Dev server wrapper (watches sentinel file, auto-restarts)
│   ├── harness-signal.ts  # Touches sentinel to trigger harness restart
│   ├── agent/       # Session lifecycle, RPC bridge, persistence, goals, teams, title generation
│   │   ├── session-manager.ts  # Create/destroy/restore sessions, broadcast events, force abort
│   │   ├── session-store.ts    # Disk persistence (~/.pi/gateway-sessions.json)
│   │   ├── rpc-bridge.ts       # JSONL stdin/stdout bridge to agent subprocess
│   │   ├── event-buffer.ts     # Circular buffer for tool_execution_update replay on reconnect
│   │   ├── title-generator.ts  # Auto-generate session titles via Claude Haiku
│   │   ├── system-prompt.ts    # Assemble system prompt from global + AGENTS.md + goal spec
│   │   ├── goal-manager.ts     # Goal CRUD operations
│   │   ├── goal-store.ts       # Disk persistence (~/.pi/gateway-goals.json)
│   │   ├── goal-artifact-store.ts  # Goal artifact storage (~/.pi/gateway-goal-artifacts.json)
│   │   ├── goal-assistant.ts   # System prompt for the goal creation assistant
│   │   ├── task-manager.ts     # Task CRUD and state transitions
│   │   ├── task-store.ts       # Disk persistence (~/.pi/gateway-tasks.json)
│   │   ├── team-manager.ts     # Team lifecycle (spawn/dismiss agents, start/complete/teardown)
│   │   ├── team-store.ts       # Disk persistence (~/.pi/gateway-team-state.json)
│   │   ├── team-names.ts       # Random name generator for team agents
│   │   ├── team-prompts.ts     # System prompts for team lead and role agents
│   │   ├── role-manager.ts     # Role definitions and management
│   │   ├── role-store.ts       # Role persistence
│   │   ├── role-assistant.ts   # System prompt for role assistant
│   │   └── color-store.ts      # Per-session color index persistence (~/.pi/gateway-session-colors.json)
│   ├── auth/        # Token auth, rate limiting, TLS, OAuth
│   │   ├── token.ts       # Load/create/validate auth tokens (~/.pi/gateway-token)
│   │   ├── rate-limit.ts  # IP-based rate limiting for auth failures
│   │   ├── tls.ts         # Self-signed TLS certificate generation (~/.pi/gateway-tls/)
│   │   └── oauth.ts       # OAuth flow (start, complete, status)
│   ├── ws/          # WebSocket protocol types and message handler
│   │   ├── protocol.ts   # ClientMessage / ServerMessage type unions
│   │   └── handler.ts    # Auth handshake, command routing, skill dispatch
│   └── skills/      # Reusable skill definitions with isolated sub-agent execution
│       ├── types.ts           # Skill interface
│       ├── registry.ts        # In-memory skill definition registry
│       ├── sub-agent.ts       # Spawn isolated agent subprocesses for skill execution
│       ├── git.ts             # Git worktree helpers
│       ├── definitions-sync.ts  # Export definitions to ~/.pi/skill-definitions.json
│       ├── index.ts           # Barrel export + auto-registration of built-in skills
│       └── definitions/       # Built-in skill templates
│           ├── code-review.ts       # Correctness, security, and design review skills
│           └── test-suite-report.ts # Test suite analysis skill
├── ui/              # Lit web components (forked from pi-web-ui, NOT an npm dep)
│   ├── ChatPanel.ts # Top-level UI orchestrator
│   ├── components/  # MessageList, StreamingMessageContainer, AgentInterface, etc.
│   │   ├── AgentInterface.ts    # Bridges agent events to UI state
│   │   ├── MessageList.ts       # Renders state.messages (completed messages)
│   │   ├── StreamingMessageContainer.ts  # Renders state.streamMessage (in-progress)
│   │   ├── Messages.ts          # Message rendering by role
│   │   ├── Input.ts             # Chat input with attachments
│   │   ├── message-renderer-registry.ts  # Custom message type renderers
│   │   └── sandbox/             # Sandboxed iframe runtime providers
│   ├── dialogs/     # ModelSelector, Settings, Sessions, AttachmentOverlay
│   ├── tools/       # Tool call renderers
│   │   ├── renderers/    # Per-tool renderers (Bash, Read, Write, Edit, Delegate, etc.)
│   │   ├── artifacts/    # Artifact display (HTML, SVG, PDF, Markdown, etc.)
│   │   └── renderer-registry.ts  # Tool name → renderer mapping
│   ├── storage/     # IndexedDB persistence (settings, provider keys, sessions)
│   └── utils/       # Formatting, auth token, model discovery, i18n
├── app/             # Browser entry point (connects to gateway)
│   ├── main.ts      # Bootstrap, routing, session sidebar, QR code, OAuth
│   ├── remote-agent.ts  # WebSocket ↔ Agent interface adapter (critical file)
│   ├── custom-messages.ts  # Custom message type definitions
│   └── oauth.ts     # Browser-side OAuth flow
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
npm run test:e2e       # E2E tests (auto-starts sandboxed gateway via Playwright webServer)
```

### Dev server harness

When developing Bobbit itself, use `npm run dev:harness` instead of `npm run dev`. The harness wraps the server process and watches a sentinel file (`~/.pi/gateway-restart`). When an agent finishes making server-side changes, it runs `npm run restart-server` to trigger:

1. Kill the running server
2. Wait for the port to clear
3. `npm run build:server` to recompile TypeScript
4. Relaunch the server

The harness also auto-restarts on unexpected crashes. Sessions survive restarts thanks to disk persistence (`~/.pi/gateway-sessions.json`).

## Key concepts

### Sessions

A **session** is a running pi-coding-agent child process, managed by `SessionManager`. Multiple WebSocket clients can connect to one session. Sessions persist to disk and restore on server restart.

**Session persistence**: Metadata (id, title, cwd, agent session file, `wasStreaming` flag) stored in `~/.pi/gateway-sessions.json`. On restart, `restoreSessions()` re-spawns agents and uses `switch_session` RPC to resume from the agent's `.jsonl` file. If an agent was mid-turn when the server died (`wasStreaming: true`), it is automatically re-prompted with a system message to continue where it left off.

### Auto-titles

When the user sends their first prompt, `tryGenerateTitleFromPrompt()` fires immediately (before the agent replies) and calls `title-generator.ts`, which sends the user text to Claude Haiku (`claude-haiku-4-5-20251001`, `max_tokens: 12`) for a 2-3 word summary. Reads auth from `~/.pi/agent/auth.json`. Falls back silently if auth is unavailable. The explicit `generate_title` WS command uses `autoGenerateTitle()` which reads the full conversation history instead.

### RPC Bridge

JSONL over stdin/stdout to the agent subprocess. Commands include: `prompt`, `steer`, `follow_up`, `abort`, `get_state`, `get_messages`, `set_model`, `compact`, `switch_session`. Each command gets a unique request ID; the bridge matches `response` messages by ID. Non-response messages are forwarded as events to all listeners.

### RemoteAgent

`src/app/remote-agent.ts` is the browser-side WebSocket client that duck-types the Agent interface so ChatPanel can use it like a local agent. This is the most complex file — handles streaming message state, deferred tool-call messages to prevent duplicate rendering, compaction state, task completion notifications, and auto-reconnection with exponential backoff.

### Deferred assistant messages

Tool-call assistant messages are held in `_deferredAssistantMessage` instead of going straight into `messages[]`. The streaming container shows them live via `streamMessage`. They flush to `messages[]` when the next `message_update` arrives (which replaces the streaming container content simultaneously) or when `agent_end` fires. This prevents both `MessageList` and `StreamingMessageContainer` from rendering the same content.

### System prompt assembly

Each session's system prompt is assembled by `system-prompt.ts` from three layers (in order):

1. Global `config/system-prompt.md`
2. `AGENTS.md` from the session's working directory (with `@ref` resolution)
3. Goal spec (if session belongs to a goal)

The `AGENTS.md` supports `@FILENAME.md` syntax — lines matching `@somefile.md` are replaced inline with the referenced file's contents (resolved relative to the file's directory, recursive, with circular reference protection via a `seen` set). The assembled prompt is written to `~/.pi/session-prompts/{sessionId}.md` and passed to the agent via `--system-prompt`. Cleaned up when a session is terminated.

### Force abort

When the user aborts a streaming session, `forceAbort()` first tries a graceful `abort` RPC. If the agent doesn't become idle within a grace period (default 3s), it kills the process, emits a synthetic `agent_end` to connected clients, then spawns a fresh agent process and resumes the session via `switch_session`. This ensures sessions remain usable even if the agent hangs.

## Goals

Goals are a task-tracking layer on top of sessions. A goal has a title, spec (markdown), working directory, and state (`todo` | `in-progress` | `done`).

**Storage**: `GoalStore` persists to `~/.pi/gateway-goals.json` (same load-on-construct, write-on-mutate pattern as `SessionStore`).

**REST API**:
- `GET /api/goals` — list all goals
- `POST /api/goals` — create a goal (`{ title, cwd, spec }`)
- `GET /api/goals/:id` — get a goal
- `PUT /api/goals/:id` — update a goal
- `DELETE /api/goals/:id` — delete a goal

**Session integration**: When creating a session with `goalId`, the goal's cwd is used as default. Goals auto-transition from `todo` to `in-progress` when their first session starts. The goal's title, state, and spec are included in the assembled system prompt.

**Goal assistant**: Sessions created with `goalAssistant: true` get a special system prompt (`GOAL_ASSISTANT_PROMPT`) that instructs the agent to help the user define a clear goal. The assistant outputs structured `<goal_proposal>` blocks with `<title>`, `<spec>`, and optional `<cwd>` tags. `RemoteAgent` parses these from assistant messages and fires the `onGoalProposal` callback.

## Skills

A skill is a named, reusable template for spawning an isolated sub-agent that produces a structured artifact. Skills replace the multi-phase workflow engine with a simpler, single-invocation model.

### Architecture

- **Types** (`src/server/skills/types.ts`): The `Skill` interface defines a skill template:
  ```typescript
  interface Skill {
    id: string;                    // e.g. "code-review", "gap-analysis"
    name: string;                  // Human-readable name
    description: string;           // What this skill does
    instructions: string;          // System prompt for the isolated sub-agent
    isolation: "full" | "partial"; // Whether the sub-agent sees parent context
    expectedOutput: string;        // Description of expected artifact format
    timeoutMs?: number;            // Max execution time (default 10min)
  }
  ```
- **Registry** (`src/server/skills/registry.ts`): In-memory store of skill definitions. Register at import time via `registerSkill()`. List/get skills at runtime.
- **Sub-agents** (`src/server/skills/sub-agent.ts`): Isolated agent subprocesses for skill execution. Receive only skill instructions + explicit context + `AGENTS.md` — never the parent conversation. 10-minute default timeout.
- **Git helpers** (`src/server/skills/git.ts`): Git worktree utilities for skills that need isolated repo access.
- **Definition sync** (`src/server/skills/definitions-sync.ts`): Exports registered skills to `~/.pi/skill-definitions.json` at startup so agent-side tool extensions can discover available skills.

### Built-in skills

- **Code Review** (`code-review.ts`): Three independent review skills — `correctness-review`, `security-review`, and `design-review`. Each reviews a different aspect of a branch diff. The Team Lead invokes them individually and synthesises findings.
- **Test Suite Report** (`test-suite-report.ts`): Single skill that analyses a test suite — creates a worktree, runs tests, and produces a structured report.

### WebSocket protocol

4 skill-related message types in `protocol.ts`:

**Client → Server**: `invoke_skill` (with `skillId` and optional `context`)

**Server → Client**: `skill_started`, `skill_completed`, `skill_failed`

### REST endpoint

- `GET /api/skills` — list available skill definitions

## Goal Artifacts

Goals can have **artifacts** — structured documents (design docs, test plans, review findings) that serve as both a process record and an enforcement mechanism.

### GoalArtifact interface

```typescript
interface GoalArtifact {
  id: string;
  goalId: string;
  name: string;              // e.g. "design-doc", "test-plan", "code-review-findings"
  type: ArtifactType;        // "design-doc" | "test-plan" | "review-findings" | "gap-analysis" | "security-findings" | "custom"
  content: string;           // The artifact content (markdown, JSON, etc.)
  producedBy: string;        // Session ID that created it
  skillId?: string;          // Skill that produced it (if applicable)
  version: number;           // Incremented on revision
  createdAt: number;
  updatedAt: number;
}
```

### Artifact requirements and enforcement

Goals can declare which artifacts must exist before certain task types are allowed:

```typescript
interface ArtifactRequirement {
  artifactType: ArtifactType;
  blocksTaskTypes: string[];   // e.g. ["implementation"]
  description: string;
}
```

**Default requirements** (applied to all team goals unless overridden):
- `design-doc` blocks `implementation` — a design document must exist before implementation tasks can be created
- `review-findings` blocks goal completion — code review findings must exist before the goal can be completed

When an agent tries to create a task via `POST /api/goals/:id/tasks`, the server checks artifact requirements. If a required artifact is missing, the request is rejected with **409 Conflict** and a message explaining which artifacts are needed. This is a hard gate — the agent must produce the required artifact first.

### Storage

`GoalArtifactStore` persists to `~/.pi/gateway-goal-artifacts.json` (same load-on-construct, write-on-mutate pattern as other stores). Artifact content is stored inline since artifacts are typically markdown/JSON documents.

### REST endpoints

- `GET /api/goals/:id/artifacts` — list artifacts for a goal
- `POST /api/goals/:id/artifacts` — create an artifact (`{ name, type, content, producedBy, skillId? }`)
- `GET /api/goals/:id/artifacts/:artifactId` — get a specific artifact
- `PUT /api/goals/:id/artifacts/:artifactId` — revise an artifact (increments version)

## Compaction

Context compaction reduces token usage by summarizing the conversation. Two modes exist:

### Manual compaction

Triggered by the user via the `compact` WS command. The handler:
1. Sets `session.isCompacting = true` and broadcasts `compaction_start`
2. Calls `rpcClient.compact()` (120s timeout) in a fire-and-forget async IIFE
3. On success: broadcasts `compaction_end` with `tokensBefore`, then refreshes messages and state
4. On failure: broadcasts `compaction_end` with error

### Auto-compaction

Triggered by the agent subprocess. Events `auto_compaction_start` / `auto_compaction_end` flow through the event system. On `auto_compaction_end` (if not aborted), `SessionManager.refreshAfterCompaction()` broadcasts refreshed messages and state.

### Client-side compaction state (RemoteAgent)

- `_isCompacting`: Tracks whether compaction is in progress. Used to re-add the placeholder message after server refreshes.
- `_compactionSyntheticMessages`: The `/compact` user message and result message are stored separately so they survive the server's post-compaction `messages` refresh (which replaces the entire message array).
- `_usageStaleAfterCompaction`: Set on `compaction_end`, cleared when a new assistant message with usage arrives. The UI checks this to avoid showing a misleading context percentage from pre-compaction state.
- A `compacting_placeholder` message (id: `"compacting_placeholder"`) is added to `messages[]` during compaction and replaced with the result on completion.

## Task completion notifications

When the agent finishes a turn, `RemoteAgent` checks how long the task took. It notifies the user via three mechanisms:
1. **Browser Notification API** — shows session title and elapsed time (requires HTTPS or localhost)
2. **Title flash** — alternates document title with "Done (Xm)" until the tab regains focus
3. **Audio beep** — two-tone sine wave (880 Hz, 1046 Hz) via Web Audio API

Notification permission is requested on first user prompt (has user gesture context).

## Reconnection

`RemoteAgent` auto-reconnects on unexpected disconnects with exponential backoff (1s base, 30s max). On reconnect:
1. Re-authenticates via `auth` message
2. Requests current messages (`get_messages`) and state (`get_state`) to resync
3. Server replays the latest `tool_execution_update` per tool call ID from the `EventBuffer` so reconnecting clients see delegate/skill progress immediately
4. If the agent is streaming and no `streamMessage` exists (late join), the last assistant message is promoted to the streaming container and removed from `messages[]` to avoid duplicate rendering

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
- Static file serving has traversal guard (resolved path must start with static dir).
- **TLS is on by default.** Self-signed certificates are auto-generated and stored at `~/.pi/gateway-tls/`. Use `--no-tls` to disable. The protocol in startup logs and QR codes is `https` by default.
- **Gateway and Vite auto-detect the NordLynx mesh IP** and bind to it. If NordVPN isn't running, the gateway exits with an error. Pass `--host <addr>` to override. Never bind to `0.0.0.0` — restrict access to the mesh network only.
- OAuth flow (`/api/oauth/start`, `/api/oauth/complete`, `/api/oauth/status`) for obtaining API credentials.

## QR code / multi-device access

The QR code dialog (`src/app/main.ts` `showQrCodeDialog()`) encodes `window.location.origin` + the auth token. Since both the gateway and Vite auto-detect and bind to the NordLynx mesh IP, the QR code will contain a routable mesh address by default. The startup logs print the full URL with the token — users can copy-paste or scan from any device on the mesh.

## Disk state summary

All persistent state lives under `~/.pi/`:

| File / Directory | Owner | Purpose |
|---|---|---|
| `gateway-token` | `token.ts` | Auth token (mode 0600) |
| `gateway-sessions.json` | `SessionStore` | Session metadata (id, title, cwd, agentSessionFile, wasStreaming) |
| `gateway-goals.json` | `GoalStore` | Goal definitions (title, spec, cwd, state) |
| `gateway-session-colors.json` | `ColorStore` | Session → color index (0-19) mapping |
| `gateway-tls/` | `tls.ts` | Self-signed TLS cert + key |
| `session-prompts/{sessionId}.md` | `system-prompt.ts` | Assembled system prompts (cleaned up on session terminate) |
| `gateway-goal-artifacts.json` | `GoalArtifactStore` | Goal artifact content and metadata |
| `gateway-team-state.json` | `TeamStore` | Team state (agents, roles, goal associations) |
| `gateway-tasks.json` | `TaskStore` | Task definitions, state, assignments |
| `skill-definitions.json` | `definitions-sync.ts` | Exported skill definitions for agent discovery |

| `agent/auth.json` | (external) | API auth credentials (read by title-generator) |
| `rpc-debug.log` | `rpc-bridge.ts` | Debug log of all RPC events |

## Git conventions

The primary branch is **`master`** (not `main`). If the user refers to "main", treat it as `master`. Never create a `main` branch.

## Development workflow

See [docs/dev-workflow.md](docs/dev-workflow.md) for the full guide on running modes, when to restart the server, and how to make changes safely.

**Quick reference**: UI changes (`src/ui/`, `src/app/`) hot-reload automatically. Server changes (`src/server/`) require `npm run restart-server` to rebuild and restart. Always run `npm run check` to verify types before triggering a restart.

## Testing

**Unit-style tests** (`npm test`): Use Playwright with `file://` fixtures — plain HTML/JS files that test logic without a build step or dev server. See `tests/mobile-header.spec.ts` and `tests/mobile-header.html` for the pattern.

**E2E tests with Playwright `webServer`** (`npm run test:e2e`): Agents **can and should** run E2E tests that need a live gateway. Use Playwright's `webServer` config to start a sandboxed server automatically — Playwright manages the server lifecycle internally, so the bash tool returns normally when tests finish. See `playwright-e2e.config.ts` for the pattern:

```typescript
// playwright-e2e.config.ts
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  webServer: {
    command: 'node dist/server/cli.js --host 127.0.0.1 --port 3099 --no-tls --no-ui',
    url: 'http://127.0.0.1:3099/api/sessions',
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  use: { baseURL: 'http://127.0.0.1:3099' },
});
```

Run with: `npm run build:server && npx playwright test --config playwright-e2e.config.ts`

The server starts on port 3099 (not 3001) to avoid conflicting with the running dev server. Build the server first since the E2E config runs the compiled JS directly.

**Do NOT start background servers manually** from bash (`node server.js &`, `nohup`, etc.) — the bash tool waits for all stdout/stderr pipes to close, so backgrounded processes that inherit those FDs cause the bash tool to hang forever and crash the agent session. Always use Playwright's `webServer` config instead, which manages server FDs internally.

**Writing new tests**: Prefer `file://` fixtures with plain HTML/JS that simulate the logic under test. Extract state machine logic into testable functions where possible. Only involve real Lit components when the bug is specifically about rendering behavior. For tests that need a real server (WebSocket flows, API integration), use the `webServer` pattern above.

## Common tasks

**Add a new REST endpoint**: Edit `src/server/server.ts` `handleApiRoute()`.

**Add a new WebSocket command**: Add to `ClientMessage` union in `src/server/ws/protocol.ts`, handle in `src/server/ws/handler.ts` switch, add convenience method on `RpcBridge` if it maps to an agent command.

**Add a new UI component**: Add to `src/ui/components/`, export from `src/ui/index.ts`.

**Add a new tool renderer**: Create in `src/ui/tools/renderers/`, register in `src/ui/tools/index.ts`.

**Add a new skill definition**: Create in `src/server/skills/definitions/`, import and register in `src/server/skills/index.ts`. Define a `Skill` object with id, instructions, isolation level, and expected output. Run `exportDefinitions()` to sync to disk.

**Add a goal-related feature**: Goal CRUD is in `goal-manager.ts`/`goal-store.ts`. REST endpoints in `server.ts`. Goal assistant prompt in `goal-assistant.ts`. Client-side proposal parsing in `remote-agent.ts` `_checkForGoalProposal()`.

**Change how messages render**: `src/ui/components/Messages.ts` for standard roles, `src/ui/components/message-renderer-registry.ts` for custom types.

**Debug duplicate messages**: The deferred message pattern in `remote-agent.ts` is subtle. `MessageList` renders `state.messages` (completed), `StreamingMessageContainer` renders `state.streamMessage` (in-progress). They must never show the same message. Tool-call messages stay in streaming until the next message starts. Check `flushDeferredMessage()` and `_deferredAssistantMessage`.

**Debug session persistence**: Check `~/.pi/gateway-sessions.json` for persisted session data. Sessions restore on startup via `session-manager.ts` `restoreSessions()`. If an agent's `.jsonl` session file is missing, that session is skipped. Failed restores create dormant entries that revive on client connect.

**Debug compaction issues**: Check `_isCompacting`, `_compactionSyntheticMessages`, and `_usageStaleAfterCompaction` in `remote-agent.ts`. The `compacting_placeholder` message must be filtered out and re-added correctly across server refreshes. Manual compaction is fire-and-forget from the WS handler's perspective.

**Debug goal artifacts**: Goal artifacts are stored in `GoalArtifactStore` (`~/.pi/gateway-goal-artifacts.json`). Artifact requirements are enforced on task creation — if the server returns 409, check which artifacts are missing via `GET /api/goals/:id/artifacts`.
