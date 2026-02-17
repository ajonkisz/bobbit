# Bobbit — Agent Guide

## What is Bobbit?
A web UI tool that lets a human Product Owner define product context (vision, personas, design, architecture) and manage AI agent delivery against that context. The tool reads/writes flat files (YAML + Markdown) stored in a Git repo.

## Repo Layout
- `src/` — Bobbit application code (the tool itself)
- `mockups/` — HTML UI mockups (single-file, no build tools)
- `docs/` — Documentation for the tool
- `examples/acme-saas/` — A sample product project showing the data format Bobbit consumes

## Key Distinction
This repo is the **tool**. The `examples/` directory contains sample product data to demonstrate the format. Real users would have their own separate repos with their product data.

## Conventions
- Mockups are single-file HTML with inline CSS/JS
- Product data format: YAML for structured data, Markdown for prose
- Keep mockups self-contained
