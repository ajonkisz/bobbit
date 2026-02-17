const BASE = '/api';

export async function fetchFile<T = unknown>(path: string): Promise<{ data: T; raw: string; path: string }> {
  const res = await fetch(`${BASE}/files/${path}`);
  if (!res.ok) throw new Error(`Failed to load ${path}`);
  return res.json();
}

export async function saveFile(path: string, content: string): Promise<void> {
  const res = await fetch(`${BASE}/files/${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`Failed to save ${path}`);
}

export async function fetchTree(): Promise<{ data: TreeNode[] }> {
  const res = await fetch(`${BASE}/tree`);
  if (!res.ok) throw new Error('Failed to load tree');
  return res.json();
}

export interface TreeNode {
  name: string;
  type: 'file' | 'dir';
  children?: TreeNode[];
}
