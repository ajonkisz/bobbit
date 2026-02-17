# Design

## Principles
- **Read-first** — Every page is readable by default. Editing is intentional, never accidental.
- **Context is king** — Always show which agents see which documents. Make the injection rules visible.
- **Flat over nested** — Sidebar tabs, not drill-down hierarchies. One click to any section.
- **Speed over features** — A fast tool with fewer features beats a slow one with many.

## Guardrails
- Dark mode only (for now). No theme switching complexity.
- No modals for primary navigation — modals only for edit/confirm flows.
- Sidebar always visible. Never hide the product structure.
- All product data rendered from flat files (YAML/MD). No database-only state.
- No drag-and-drop. Explicit ordering via edit.

## Aesthetic
- Dark, dense, professional. Linear meets Vercel.
- Monospace for file paths and code references.
- Accent color (indigo) used sparingly for interactive elements.
- Semantic colors: green (done/active), yellow (in progress), orange (review), red (guardrails/blocked), blue (planning).

## Inspiration
- **Linear** — information density, keyboard-first, dark mode done right
- **Vercel Dashboard** — deployment status, clean metrics, minimal chrome
- **GitHub** — file-backed content, diff views, review flows
- **Notion** — structured documents with multiple views
