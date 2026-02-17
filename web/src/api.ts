const BASE = '/api';

export async function fetchFile<T = unknown>(path: string): Promise<{ data: T; raw: string; path: string }> {
  const res = await fetch(`${BASE}/files/${path}`);
  if (!res.ok) throw new Error(`Failed to load ${path}`);
  return res.json();
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
