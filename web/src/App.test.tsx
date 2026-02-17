import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';

// Sample data matching the real example files
const MOCK_DATA: Record<string, { data: unknown; raw: string; path: string }> = {
  'context/vision.yaml': {
    data: {
      mission: 'Test mission statement',
      vision: 'Test vision summary',
      what_we_are: 'Test what we are',
      what_we_are_not: ['Not this', 'Not that'],
    },
    raw: 'mission: Test mission',
    path: 'context/vision.yaml',
  },
  'context/personas.yaml': {
    data: {
      personas: [
        { id: 'alex', name: 'Alex', title: 'Product Owner', tier: 'primary', background: 'Builds things', quote: 'Ship it' },
        { id: 'jordan', name: 'Jordan', title: 'Tech Lead', tier: 'secondary', background: 'Leads team' },
      ],
    },
    raw: 'personas: ...',
    path: 'context/personas.yaml',
  },
  'product/design.md': {
    data: '# Design\n\n## Principles\n- Speed over features',
    raw: '# Design\n\n## Principles\n- Speed over features',
    path: 'product/design.md',
  },
  'product/architecture.md': {
    data: '# Architecture\n\n## Guardrails\n- No ORMs',
    raw: '# Architecture\n\n## Guardrails\n- No ORMs',
    path: 'product/architecture.md',
  },
  'product/glossary.yaml': {
    data: {
      terms: [
        { term: 'Project', definition: 'A Git repo with product files' },
        { term: 'Agent', definition: 'An AI coding assistant' },
      ],
    },
    raw: 'terms: ...',
    path: 'product/glossary.yaml',
  },
  'delivery/roadmap.yaml': {
    data: {
      workstreams: [
        {
          name: 'Product Definition UI',
          milestones: [
            { title: 'Static mockup', status: 'done' },
            { title: 'File-backed rendering', status: 'not_started' },
          ],
        },
      ],
    },
    raw: 'workstreams: ...',
    path: 'delivery/roadmap.yaml',
  },
};

// Mock the fetch API
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const path = url.replace('/api/files/', '');
    const data = MOCK_DATA[path];
    if (!data) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(data),
    });
  }));
});

describe('App', () => {
  it('renders the chrome bar with Bobbit brand', async () => {
    render(<App />);
    expect(screen.getAllByText('Bobbit').length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector('.chrome-brand')?.textContent).toBe('Bobbit');
  });

  it('renders sidebar with all sections', async () => {
    render(<App />);
    expect(screen.getByText('Context')).toBeInTheDocument();
    expect(screen.getByText('Product')).toBeInTheDocument();
    expect(screen.getByText('Delivery')).toBeInTheDocument();
    expect(screen.getByText('Vision')).toBeInTheDocument();
    expect(screen.getByText('Users & Stories')).toBeInTheDocument();
    expect(screen.getByText('Design')).toBeInTheDocument();
    expect(screen.getByText('Architecture')).toBeInTheDocument();
    expect(screen.getByText('Glossary')).toBeInTheDocument();
    expect(screen.getByText('Roadmap')).toBeInTheDocument();
  });

  it('renders vision tab with data from YAML', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Mission Statement')).toBeInTheDocument();
      expect(screen.getByText('Test mission statement')).toBeInTheDocument();
      expect(screen.getByText('What We Are Not')).toBeInTheDocument();
      expect(screen.getByText('Not this')).toBeInTheDocument();
    });
  });

  it('renders personas tab without crashing', async () => {
    render(<App />);
    await userEvent.click(screen.getByText('Users & Stories'));
    await waitFor(() => {
      expect(screen.getByText(/Alex — Product Owner/)).toBeInTheDocument();
      expect(screen.getByText(/Jordan — Tech Lead/)).toBeInTheDocument();
      expect(screen.getByText('primary')).toBeInTheDocument();
    });
  });

  it('renders glossary tab with terms', async () => {
    render(<App />);
    await userEvent.click(screen.getByText('Glossary'));
    await waitFor(() => {
      expect(screen.getByText('Project')).toBeInTheDocument();
      expect(screen.getByText('A Git repo with product files')).toBeInTheDocument();
    });
  });

  it('renders roadmap tab with workstreams', async () => {
    render(<App />);
    await userEvent.click(screen.getByText('Roadmap'));
    await waitFor(() => {
      expect(screen.getByText('Product Definition UI')).toBeInTheDocument();
      expect(screen.getByText('Static mockup')).toBeInTheDocument();
      expect(screen.getByText('done')).toBeInTheDocument();
    });
  });

  it('renders design tab (markdown)', async () => {
    render(<App />);
    await userEvent.click(screen.getByText('Design'));
    await waitFor(() => {
      expect(screen.getByText(/Speed over features/)).toBeInTheDocument();
    });
  });

  it('renders architecture tab (markdown)', async () => {
    render(<App />);
    await userEvent.click(screen.getByText('Architecture'));
    await waitFor(() => {
      expect(screen.getByText(/No ORMs/)).toBeInTheDocument();
    });
  });

  it('shows loading state before data arrives', () => {
    // Make fetch never resolve
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<App />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('clears data between tab switches (no stale render)', async () => {
    render(<App />);
    // Wait for vision to load
    await waitFor(() => {
      expect(screen.getByText('Mission Statement')).toBeInTheDocument();
    });
    // Switch to personas — should show loading, not crash
    await userEvent.click(screen.getByText('Users & Stories'));
    // Should eventually show personas without error
    await waitFor(() => {
      expect(screen.getByText(/Alex — Product Owner/)).toBeInTheDocument();
    });
  });
});
