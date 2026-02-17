# Bobbit

Agent workforce manager for product owners.

Code generation is cheap. Coherence is hard. Bobbit gives a human Product Owner control over an AI agent workforce — keeping multiple agents aligned with a shared vision, design, and architecture.

## Quick Start

```bash
npm install
npm run dev        # starts server on :3001 and web UI on :5173
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

## Project Structure

```
bobbit/
├── server/                 # Hono API server (TypeScript)
│   └── index.ts            # File read/write API over project data
├── web/                    # React + Vite frontend
│   ├── src/App.tsx         # All UI components
│   ├── src/App.test.tsx    # 48 tests (Vitest + happy-dom)
│   ├── src/index.css       # Stripe-inspired theme system
│   └── src/api.ts          # API client helpers
├── examples/bobbit/        # Bobbit's own product definition (dogfooding)
│   ├── context/            # vision.yaml, personas.yaml, stories.yaml
│   ├── product/            # design.md, architecture.md, glossary.yaml
│   └── delivery/           # roadmap.yaml
└── mockups/                # Legacy HTML mockups
```

## How It Works

A Bobbit **project** is a Git repo containing YAML and Markdown files that define a product. The server reads/writes these files. The web UI provides structured editing with context about which agents consume each document.

### Architecture

- **Server:** Hono on Node.js. Serves project files as parsed YAML/raw Markdown via REST API (`GET/PUT /api/files/*`). Defaults to reading from `examples/bobbit/`, configurable via `BOBBIT_PROJECT` env var.
- **Frontend:** React 19 + Vite. Single-page app with sidebar navigation across six document types: Vision, Users & Stories, Design, Architecture, Glossary, and Roadmap. Each document has inline editing with save/cancel.
- **Theming:** Light (default) and dark mode. Stripe docs-inspired design with always-dark chrome bar, neon SVG icons, and hover tooltips showing agent context.

### Tabs

| Tab | File | Format | Agent scope |
|-----|------|--------|-------------|
| Vision | `context/vision.yaml` | 4 structured sections | All agents |
| Users & Stories | `context/personas.yaml` | Persona cards | Design agents |
| Design | `product/design.md` | Markdown | Design agents |
| Architecture | `product/architecture.md` | Markdown | Engineering agents |
| Glossary | `product/glossary.yaml` | Term/definition pairs | All agents |
| Roadmap | `delivery/roadmap.yaml` | Workstreams + milestones | Planning agents |

## Testing

```bash
npm test           # Run all 48 tests
npm run test:watch # Watch mode
```

Tests use Vitest with happy-dom and @testing-library/react. They cover rendering, navigation, inline editing (save/cancel), and content display for all six tabs.

## Status

Active development — functional web UI with full CRUD for all document types.
