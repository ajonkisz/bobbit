# Bobbit — Agent Guide

## What is Bobbit?
A web UI tool that lets a human Product Owner define product context (vision, personas, design, architecture) and manage AI agent delivery against that context. The tool reads/writes flat files (YAML + Markdown) stored in a Git repo.

## Repo Layout
```
bobbit/
├── server/                     # Hono API server (TypeScript, tsx)
│   └── index.ts                # Single-file API: GET/PUT /api/files/*, /api/tree
├── web/                        # React frontend (Vite + TypeScript)
│   ├── src/
│   │   ├── App.tsx             # ALL components in one file (see Component Architecture)
│   │   ├── App.test.tsx        # 48 Vitest tests (happy-dom)
│   │   ├── api.ts              # fetchFile, saveFile, fetchTree helpers
│   │   ├── index.css           # Full CSS — themes, chrome, layout, icons, tooltips
│   │   ├── main.tsx            # React entry point
│   │   └── test-setup.ts       # @testing-library/jest-dom/vitest
│   ├── public/bobbit.svg       # Favicon — hexagonal node logo in #6366f1
│   └── index.html              # Shell — loads Inter font from Google Fonts
├── examples/bobbit/            # Dogfooded product data (Bobbit defines itself)
│   ├── context/                # vision.yaml, personas.yaml, stories.yaml, competitors.md
│   ├── product/                # design.md, architecture.md, glossary.yaml
│   └── delivery/               # roadmap.yaml
├── mockups/                    # Legacy HTML mockups (pre-React)
└── docs/                       # Tool documentation
```

## Running
```bash
npm run dev          # Starts both server (:3001) and web (:5173) via concurrently
npm run dev:server   # Server only
npm run dev:web      # Frontend only
npm test             # Run all 48 Vitest tests (web workspace)
npm run test:watch   # Watch mode
```

## Key Architecture

### Server (`server/index.ts`)
- Hono + @hono/node-server on port 3001
- Reads project data from `examples/bobbit/` by default (override via `BOBBIT_PROJECT` env var)
- CORS configured for `http://localhost:5173`
- Endpoints: `GET /api/files` (list), `GET /api/files/*` (read+parse), `PUT /api/files/*` (write), `GET /api/tree`

### Frontend (`web/src/App.tsx`)
All components live in a single file. Key structures:

**Data mappings:**
- `TABS` — sidebar navigation structure (section → items with id, label, file path)
- `FILE_CONTEXT` — maps file paths to `{ label, description }` for agent context tooltips
- `CONTEXT_ICONS` — maps agent scope labels to neon SVG icons (All agents → sparkle, Design → pen, Engineering → code brackets, Planning → flag)
- `PAGE_ICONS` — maps tab ids to unique per-page SVG icons (users → people, design → paintbrush, architecture → brackets, glossary → book, roadmap → winding path)
- `VISION_SECTIONS` — defines the 4 vision card sections with optional per-section icon overrides

**Components:**
- `App` — shell: chrome bar, sidebar nav, content area, tab switching
- `ThemeToggle` — light/dark toggle (light default, toggles `html.dark` class, persists to localStorage)
- `InfoTooltip` — wraps icon + children as hover target; shows inverted dark popover with agent context info. Accepts optional `icon` prop to override default.
- `FileView` — router: selects view based on tab id and file type
- `VisionView` — 4 editable sections (Mission Statement, Product Vision Summary, This Product Is, This Product Is Not)
- `PersonasView` — collapsible persona cards with tier pills
- `GlossaryView` — grid table of term/definition pairs
- `RoadmapView` — workstreams with milestone cards and status pills
- `MarkdownView` — raw markdown display with full-file editing
- `Section` — shared card wrapper with InfoTooltip heading, edit/save/cancel controls

### CSS (`web/src/index.css`)
- **Theme system:** `:root` = light (Stripe-inspired: `--bg-0: #f6f9fc`, `--accent: #635bff`), `html.dark` = dark navy palette
- **Chrome bar:** Always dark gradient with animated accent line (25s shimmer) and gradient brand text (20s shimmer)
- **Icons:** `.ctx-icon` — 27×24px neon glow via `drop-shadow` filter in accent color; `.ctx-hover-target:hover` intensifies glow
- **Tooltips:** `.ctx-popover` — inverted dark popover (`#1a1a2e`), always dark regardless of theme, with arrow caret and slide-up entrance
- **Cards:** `.section` with subtle shadow, hover shadow lift
- **Pill badges:** `.pill-green/yellow/orange/blue/gray` for status indicators

## Test Constraints (48 tests)
Tests use @testing-library/react with happy-dom. Key DOM queries that **must** be preserved:
- `.chrome-brand` textContent === `"Bobbit"`
- `.product-tab.active` textContent === `"Bobbit"`
- `getByText('Mission Statement')`, `getByText('Product Vision Summary')`, `getByText('This Product Is')`, `getByText('This Product Is Not')`
- `getAllByText('All agents').length >= 4`
- `getAllByText(/Injected into every agent/) >= 1`
- `getAllByText('Design agents') >= 1` (from h2 tooltip popover on Users tab)
- `getByText('Design agents')` on Design tab, `getByText('Engineering agents')` on Architecture tab
- All `.edit-btn`, `.edit-textarea`, `.edit-form`, `.edit-input`, `.edit-select` class selectors
- `.sidebar-item.active` selector

## Conventions
- All components in `App.tsx` — no separate component files
- Product data format: YAML for structured data, Markdown for prose
- SVG icons defined as JSX constants, not external files
- CSS custom properties for all colors — never hardcode colors in components (except the always-dark chrome bar)
- Animations must be subtle (20-25s cycles, not flashy)
- Tests must pass after every change: `npm test` from repo root
