# Architecture

## Technical Guardrails
- Product data is YAML + Markdown in Git. No proprietary formats.
- The web UI is a reader/editor for these files. Git is the source of truth.
- No user accounts or auth in v1 — single-user local tool.
- No database in v1 — file system only.

## Data Model
A Bobbit **project** is a directory (Git repo) with this structure:
```
<project>/
  context/
    vision.yaml       # mission, vision, what we are/aren't
    personas.yaml     # user personas
    stories.yaml      # user stories linked to personas
    competitors.md    # competitive landscape
  product/
    design.md         # principles, guardrails, aesthetic
    architecture.md   # technical patterns, guardrails, sitemap
    glossary.yaml     # shared terminology
  delivery/
    roadmap.yaml      # workstreams and milestones
```

## Context Injection
Each document section has an injection rule defining which agent roles receive it:
- `all_agents` — mission, vision, what we are/aren't (short, always included)
- `design_agents` — personas, stories, competitors, design principles
- `engineering_agents` — architecture, technical guardrails, patterns
- `all_agents` — glossary (shared vocabulary)

## Tech Stack (TBD)
- Web UI: likely React or vanilla JS
- Backend: lightweight server that reads/writes project files
- No build step preferred for v1 — keep it simple
