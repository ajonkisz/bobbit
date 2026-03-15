# Development Workflow

How to run, develop, and deploy Bobbit. For project architecture and concepts see [README.md](../README.md). For agent-facing context (repo layout, key abstractions, common tasks) see [AGENTS.md](../AGENTS.md).

---

## Running modes

Bobbit has three runtime modes: **production**, **dev**, and **dev with harness**. The difference is how server-side TypeScript is compiled and how the UI is served.

### Production

```bash
npm run build   # compile server + bundle UI
npm start       # serve everything from dist/
```

The gateway serves the bundled UI from `dist/ui/` as static files. Everything runs from a single process (plus agent child processes). No hot reload — you must rebuild and restart to pick up changes.

### Dev (no harness)

```bash
npm run build:server   # required once before first run
npm run dev            # gateway + vite dev server
```

Runs two processes concurrently:

1. **Gateway** (`node dist/server/cli.js --cwd . --no-ui`) on port 3001 — handles REST API, WebSocket, and agent subprocesses.
2. **Vite** on port 5173 — serves the UI with hot module replacement. Proxies `/api` and `/ws` to the gateway.

UI changes (`src/ui/`, `src/app/`) hot-reload instantly in the browser. Server changes (`src/server/`) require manually rebuilding (`npm run build:server`) and restarting the gateway.

### Dev with harness (recommended)

```bash
npm run dev:harness
```

Same two-process setup, but the gateway is wrapped in a **restart harness** (`src/server/harness.ts`). The harness:

- Watches a sentinel file at `~/.pi/gateway-restart`
- On signal: kills the server, waits for the port to free, runs `npm run build:server`, relaunches
- Auto-restarts on unexpected crashes
- Sessions survive restarts (persisted to `~/.pi/gateway-sessions.json`)

To trigger a restart:

```bash
npm run restart-server
```

This touches the sentinel file. The harness picks it up within ~500ms (polled on Windows, `fs.watch` elsewhere) and begins the restart cycle.

---

## What changes require what

| What you changed | What to do |
|---|---|
| `src/ui/**` or `src/app/**` | Nothing — Vite hot-reloads automatically |
| `src/server/**` | Run `npm run restart-server` (if using harness) or manually `npm run build:server` + restart |
| `package.json` (new dependency) | `npm install`, then restart server |
| `vite.config.ts` | Restart Vite (kill and re-run `npm run dev:harness`) |
| `tsconfig.*.json` | Restart server; may need to restart Vite for web config changes |
| `config/system-prompt.md` | Restart server (the path is resolved at startup and passed to agents) |

**Rule of thumb**: UI is hot. Server is compiled. If you touched anything under `src/server/`, you need a rebuild + restart.

---

## For agents making changes

If you are an AI agent running inside a Bobbit session and you are modifying Bobbit itself:

### UI changes — no action needed

Edit files under `src/ui/` or `src/app/`. Vite picks up the changes and hot-reloads the browser. The user sees updates within seconds. No restart, no build command.

### Server changes — trigger a restart

After editing files under `src/server/`:

```bash
npm run restart-server
```

This signals the harness to rebuild and restart the server. Your current session will survive — the harness persists session metadata to disk, and on relaunch the server restores all sessions from `~/.pi/gateway-sessions.json`.

**Do not skip this step.** The gateway runs from compiled JavaScript in `dist/server/`. Your TypeScript edits under `src/server/` have no effect until the server is rebuilt.

### Verify your changes compiled

After `npm run restart-server`, watch for the harness output:

```
[harness] ======== RESTART TRIGGERED ========
[harness] Waiting for port 3001 to be free...
[harness] Building server...
[harness] Build complete.
[harness] Launching server (port 3001)...
```

If the build fails, the harness logs the error and attempts to launch the old build anyway. Fix the compilation error and run `npm run restart-server` again.

### Type-checking without restarting

To check both server and UI types without emitting or restarting:

```bash
npm run check
```

This runs `tsc --noEmit` against both `tsconfig.server.json` and `tsconfig.web.json`. Useful to catch errors before triggering a restart.

### Adding new files

New files under `src/server/` are automatically picked up by the next `npm run build:server` (triggered by the harness). No extra configuration needed — the TypeScript config includes all `.ts` files under `src/server/`.

New UI files need to be imported somewhere in the dependency graph (from `src/app/main.ts` or an existing component). Vite handles the rest.

---

## Build outputs

```
dist/
├── server/         # tsc output from src/server/ (Node16 ESM)
│   ├── cli.js      # gateway entry point
│   ├── harness.js  # dev server harness
│   └── agent/      # session manager, RPC bridge, stores
└── ui/             # vite bundle from src/ui/ + src/app/
    ├── index.html  # SPA entry
    └── assets/     # JS, CSS, fonts
```

Two independent build pipelines:

- **Server**: `tsc -p tsconfig.server.json` → `dist/server/`. Plain TypeScript compilation, no bundling.
- **UI**: `vite build` → `dist/ui/`. Bundles, minifies, tree-shakes. In dev mode, Vite serves directly from source with HMR.

---

## Port and host binding

Both the gateway and Vite auto-detect the NordLynx (NordVPN mesh) interface IP. If NordVPN is not running:

- **Gateway**: exits with an error unless you pass `--host <addr>`
- **Vite**: falls back to `localhost` with a warning, or uses `VITE_HOST` env var

For local-only development without NordVPN:

```bash
# Terminal 1: gateway on localhost
node dist/server/cli.js --host localhost --port 3001 --cwd . --no-ui

# Terminal 2: vite on localhost
VITE_HOST=localhost npx vite
```

Or use the e2e test config which does this automatically:

```bash
npx playwright test --config tests/playwright-e2e.config.ts
```

---

## Testing

```bash
npm test              # Mobile header Playwright tests (standalone)
npm run test:e2e      # E2E integration tests (starts gateway + vite on localhost)
```

E2E tests use `tests/playwright-e2e.config.ts` which starts both the gateway and Vite on localhost automatically. Tests run against the real system — creating sessions, sending prompts, verifying UI behavior.

---

## Related docs

- **[README.md](../README.md)** — Architecture overview, REST API reference, security model, CLI flags
- **[AGENTS.md](../AGENTS.md)** — Agent context: repo layout, key concepts, common tasks, debugging tips
