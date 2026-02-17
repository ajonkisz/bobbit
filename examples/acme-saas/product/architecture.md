# Architecture

## Technical Guardrails
- No passport.js — Direct OAuth flows for full control
- No ORMs — Raw SQL with parameterized queries only
- Test coverage >= 80%

## Patterns
- **API envelope** — `{ data, error, meta }` on all responses
- **Middleware** — Composable: `requireAuth`, `optionalAuth`, `requireRole`
- **Components** — Max 3 nesting levels. No prop drilling past 2.

## Sitemap
```
/ (App Shell)
  /dashboard       — KPI cards, charts
  /explore         — Data explorer (no SQL)
  /team            — Members, roles, invites
  /settings        — Account, billing, API keys
/ (Public)
  /login · /register · /shared/:token
```
