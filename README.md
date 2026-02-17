# Bobbit

Agent workforce manager for product owners.

Code generation is cheap. Coherence is hard. Bobbit gives a human Product Owner control over an AI agent workforce — keeping multiple agents aligned with a shared vision, design, and architecture.

## Project Structure

```
bobbit/
├── src/                    # Bobbit application source
├── mockups/                # UI design mockups
├── docs/                   # Tool documentation
└── examples/
    └── acme-saas/          # Example product managed by Bobbit
        ├── context/        # Vision, personas, stories (YAML/MD)
        ├── product/        # Design, architecture, glossary
        └── delivery/       # Roadmap, tasks
```

## How It Works

A Bobbit **project** is a Git repo containing YAML and Markdown files that define a product. Bobbit reads these files, serves a web UI for editing them, and injects relevant sections into agent contexts during delivery.

## Status

Early design phase — iterating on UX mockups before building.
