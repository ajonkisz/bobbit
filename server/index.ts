import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { join, relative, extname } from 'path';
import yaml from 'js-yaml';

// Project root: defaults to examples/bobbit, overridable via env
const PROJECT_DIR = process.env.BOBBIT_PROJECT
  ?? join(import.meta.dirname, '..', 'examples', 'bobbit');

const app = new Hono();

app.use('*', cors({ origin: 'http://localhost:5173' }));

// ── List all files in the project ──
app.get('/api/files', async (c) => {
  const files = await listFiles(PROJECT_DIR);
  return c.json({ data: files });
});

// ── Read a single file (parsed) ──
app.get('/api/files/*', async (c) => {
  const filePath = c.req.path.replace('/api/files/', '');
  const fullPath = join(PROJECT_DIR, filePath);

  // Prevent path traversal
  if (!fullPath.startsWith(PROJECT_DIR)) {
    return c.json({ error: 'Invalid path' }, 403);
  }

  try {
    const raw = await readFile(fullPath, 'utf-8');
    const ext = extname(fullPath);

    if (ext === '.yaml' || ext === '.yml') {
      return c.json({ data: yaml.load(raw), raw, path: filePath });
    }
    // Markdown and other text files
    return c.json({ data: raw, raw, path: filePath });
  } catch {
    return c.json({ error: 'File not found' }, 404);
  }
});

// ── Write a file ──
app.put('/api/files/*', async (c) => {
  const filePath = c.req.path.replace('/api/files/', '');
  const fullPath = join(PROJECT_DIR, filePath);

  if (!fullPath.startsWith(PROJECT_DIR)) {
    return c.json({ error: 'Invalid path' }, 403);
  }

  const body = await c.req.json<{ content: string }>();
  await writeFile(fullPath, body.content, 'utf-8');
  return c.json({ ok: true, path: filePath });
});

// ── Project structure (tree) ──
app.get('/api/tree', async (c) => {
  const tree = await buildTree(PROJECT_DIR);
  return c.json({ data: tree });
});

// ── Helpers ──
async function listFiles(dir: string, base = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listFiles(join(dir, entry.name), rel));
    } else {
      files.push(rel);
    }
  }
  return files;
}

interface TreeNode {
  name: string;
  type: 'file' | 'dir';
  children?: TreeNode[];
}

async function buildTree(dir: string): Promise<TreeNode[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nodes: TreeNode[] = [];
  for (const entry of entries.sort((a, b) => {
    // dirs first, then files
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  })) {
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        type: 'dir',
        children: await buildTree(join(dir, entry.name)),
      });
    } else {
      nodes.push({ name: entry.name, type: 'file' });
    }
  }
  return nodes;
}

const port = Number(process.env.PORT ?? 3001);
console.log(`Bobbit API running on http://localhost:${port}`);
console.log(`Reading project from: ${PROJECT_DIR}`);
serve({ fetch: app.fetch, port });
