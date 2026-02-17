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
    data: '# Design\n\n## Principles\n- Speed over features\n\n## Guardrails\n- No modals for primary actions',
    raw: '# Design\n\n## Principles\n- Speed over features\n\n## Guardrails\n- No modals for primary actions',
    path: 'product/design.md',
  },
  'product/architecture.md': {
    data: '# Architecture\n\n## Technical Guardrails\n- No ORMs\n\n## Patterns\n- API envelope',
    raw: '# Architecture\n\n## Technical Guardrails\n- No ORMs\n\n## Patterns\n- API envelope',
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
          description: 'The sidebar-driven document viewer',
          milestones: [
            { title: 'Static mockup', status: 'done' },
            { title: 'File-backed rendering', status: 'not_started' },
          ],
        },
        {
          name: 'Context Injection',
          milestones: [
            { title: 'Define injection rules', status: 'not_started' },
          ],
        },
      ],
    },
    raw: 'workstreams: ...',
    path: 'delivery/roadmap.yaml',
  },
};

// Helper: create a fetch mock that handles both GET and PUT
function createFetchMock() {
  return vi.fn((url: string, options?: RequestInit) => {
    if (options?.method === 'PUT') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    }
    const path = url.replace('/api/files/', '');
    const data = MOCK_DATA[path];
    if (!data) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(data),
    });
  });
}

// Mock the fetch API
beforeEach(() => {
  vi.stubGlobal('fetch', createFetchMock());
});

describe('App shell', () => {
  it('renders chrome bar with brand and product tab', async () => {
    render(<App />);
    expect(document.querySelector('.chrome-brand')?.textContent).toBe('Bobbit');
    expect(document.querySelector('.product-tab.active')?.textContent).toBe('Bobbit');
  });

  it('renders sidebar with all section headers', () => {
    render(<App />);
    expect(screen.getByText('Context')).toBeInTheDocument();
    expect(screen.getByText('Product')).toBeInTheDocument();
    expect(screen.getByText('Delivery')).toBeInTheDocument();
  });

  it('renders every sidebar tab item', () => {
    render(<App />);
    const expectedTabs = ['Vision', 'Users & Stories', 'Design', 'Architecture', 'Glossary', 'Roadmap'];
    for (const tab of expectedTabs) {
      expect(screen.getByText(tab)).toBeInTheDocument();
    }
  });

  it('shows loading state before data arrives', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<App />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows error state on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500 })));
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Failed to load/)).toBeInTheDocument();
    });
  });
});

describe('Vision tab', () => {
  it('renders all four vision sections', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Mission Statement')).toBeInTheDocument();
      expect(screen.getByText('Product Vision Summary')).toBeInTheDocument();
      expect(screen.getByText('What We Are')).toBeInTheDocument();
      expect(screen.getByText('What We Are Not')).toBeInTheDocument();
    });
  });

  it('shows mission content from YAML', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Test mission statement')).toBeInTheDocument();
    });
  });

  it('shows vision summary content', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Test vision summary')).toBeInTheDocument();
    });
  });

  it('shows what we are content', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Test what we are')).toBeInTheDocument();
    });
  });

  it('shows what we are not as a list', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Not this')).toBeInTheDocument();
      expect(screen.getByText('Not that')).toBeInTheDocument();
    });
  });

  it('shows context injection badges', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getAllByText('All agents').length).toBeGreaterThanOrEqual(4);
    });
  });

  it('shows file references', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getAllByText('context/vision.yaml').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows edit buttons on each section', async () => {
    render(<App />);
    await waitFor(() => {
      const editBtns = document.querySelectorAll('.edit-btn');
      expect(editBtns.length).toBeGreaterThanOrEqual(4);
    });
  });
});

describe('Users & Stories tab', () => {
  async function openUsersTab() {
    render(<App />);
    await userEvent.click(screen.getByText('Users & Stories'));
  }

  it('renders all personas', async () => {
    await openUsersTab();
    await waitFor(() => {
      expect(screen.getByText(/Alex — Product Owner/)).toBeInTheDocument();
      expect(screen.getByText(/Jordan — Tech Lead/)).toBeInTheDocument();
    });
  });

  it('shows persona tiers', async () => {
    await openUsersTab();
    await waitFor(() => {
      expect(screen.getByText('primary')).toBeInTheDocument();
      expect(screen.getByText('secondary')).toBeInTheDocument();
    });
  });

  it('shows persona background', async () => {
    await openUsersTab();
    await waitFor(() => {
      expect(screen.getByText('Builds things')).toBeInTheDocument();
    });
  });

  it('shows persona quotes when present', async () => {
    await openUsersTab();
    await waitFor(() => {
      expect(screen.getByText(/"Ship it"/)).toBeInTheDocument();
    });
  });

  it('shows design agents context badge', async () => {
    await openUsersTab();
    await waitFor(() => {
      expect(screen.getByText('Design agents')).toBeInTheDocument();
    });
  });
});

describe('Design tab', () => {
  async function openDesignTab() {
    render(<App />);
    await userEvent.click(screen.getByText('Design'));
  }

  it('renders markdown content', async () => {
    await openDesignTab();
    await waitFor(() => {
      expect(screen.getByText(/Speed over features/)).toBeInTheDocument();
    });
  });

  it('shows guardrails section', async () => {
    await openDesignTab();
    await waitFor(() => {
      expect(screen.getByText(/No modals for primary actions/)).toBeInTheDocument();
    });
  });

  it('shows file reference in heading', async () => {
    await openDesignTab();
    await waitFor(() => {
      expect(screen.getByText('product/design.md')).toBeInTheDocument();
    });
  });
});

describe('Architecture tab', () => {
  async function openArchTab() {
    render(<App />);
    await userEvent.click(screen.getByText('Architecture'));
  }

  it('renders markdown content', async () => {
    await openArchTab();
    await waitFor(() => {
      expect(screen.getByText(/No ORMs/)).toBeInTheDocument();
    });
  });

  it('shows patterns section', async () => {
    await openArchTab();
    await waitFor(() => {
      expect(screen.getByText(/API envelope/)).toBeInTheDocument();
    });
  });

  it('shows file reference in heading', async () => {
    await openArchTab();
    await waitFor(() => {
      expect(screen.getByText('product/architecture.md')).toBeInTheDocument();
    });
  });
});

describe('Glossary tab', () => {
  async function openGlossaryTab() {
    render(<App />);
    await userEvent.click(screen.getByText('Glossary'));
  }

  it('renders all terms', async () => {
    await openGlossaryTab();
    await waitFor(() => {
      expect(screen.getByText('Project')).toBeInTheDocument();
      expect(screen.getByText('Agent')).toBeInTheDocument();
    });
  });

  it('renders definitions next to terms', async () => {
    await openGlossaryTab();
    await waitFor(() => {
      expect(screen.getByText('A Git repo with product files')).toBeInTheDocument();
      expect(screen.getByText('An AI coding assistant')).toBeInTheDocument();
    });
  });

  it('shows description text', async () => {
    await openGlossaryTab();
    await waitFor(() => {
      expect(screen.getByText(/Agents must use these terms/)).toBeInTheDocument();
    });
  });
});

describe('Roadmap tab', () => {
  async function openRoadmapTab() {
    render(<App />);
    await userEvent.click(screen.getByText('Roadmap'));
  }

  it('renders all workstreams', async () => {
    await openRoadmapTab();
    await waitFor(() => {
      expect(screen.getByText('Product Definition UI')).toBeInTheDocument();
      expect(screen.getByText('Context Injection')).toBeInTheDocument();
    });
  });

  it('renders milestones within workstreams', async () => {
    await openRoadmapTab();
    await waitFor(() => {
      expect(screen.getByText('Static mockup')).toBeInTheDocument();
      expect(screen.getByText('File-backed rendering')).toBeInTheDocument();
      expect(screen.getByText('Define injection rules')).toBeInTheDocument();
    });
  });

  it('shows status pills on milestones', async () => {
    await openRoadmapTab();
    await waitFor(() => {
      expect(screen.getByText('done')).toBeInTheDocument();
      expect(screen.getAllByText('not started').length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe('Tab switching', () => {
  it('clears data between tab switches (no stale render crash)', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Mission Statement')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByText('Users & Stories'));
    await waitFor(() => {
      expect(screen.getByText(/Alex — Product Owner/)).toBeInTheDocument();
    });
  });

  it('can navigate through all tabs without crashing', async () => {
    render(<App />);

    // Vision loads by default
    await waitFor(() => expect(screen.getByText('Mission Statement')).toBeInTheDocument());

    // Click through every other tab
    const tabs = ['Users & Stories', 'Design', 'Architecture', 'Glossary', 'Roadmap'];
    for (const tab of tabs) {
      await userEvent.click(screen.getByText(tab));
      // Just verify it didn't crash and shows something
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      });
    }
  });

  it('highlights active sidebar item', async () => {
    render(<App />);
    const sidebar = document.querySelector('.sidebar')!;
    // Vision should be active by default
    const visionItem = sidebar.querySelector('.sidebar-item.active');
    expect(visionItem?.textContent).toBe('Vision');

    await userEvent.click(screen.getByText('Glossary'));
    await waitFor(() => {
      const activeItem = sidebar.querySelector('.sidebar-item.active');
      expect(activeItem?.textContent).toBe('Glossary');
    });
  });
});

// ── Edit mode tests ──

describe('Vision edit mode', () => {
  it('clicking Edit shows textarea with current content', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Mission Statement')).toBeInTheDocument());

    // Click the first Edit button (Mission Statement section)
    const editBtns = document.querySelectorAll('.edit-btn');
    await userEvent.click(editBtns[0]);

    const textarea = document.querySelector('.edit-textarea') as HTMLTextAreaElement;
    expect(textarea).toBeInTheDocument();
    expect(textarea.value).toBe('Test mission statement');
  });

  it('clicking Cancel hides textarea without API call', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Mission Statement')).toBeInTheDocument());

    const editBtns = document.querySelectorAll('.edit-btn');
    await userEvent.click(editBtns[0]);
    expect(document.querySelector('.edit-textarea')).toBeInTheDocument();

    const fetchCallsBefore = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await userEvent.click(screen.getByText('Cancel'));

    expect(document.querySelector('.edit-textarea')).not.toBeInTheDocument();
    // No new fetch calls (no PUT)
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(fetchCallsBefore);
  });

  it('Save sends PUT with updated YAML and refreshes', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Mission Statement')).toBeInTheDocument());

    const editBtns = document.querySelectorAll('.edit-btn');
    await userEvent.click(editBtns[0]);

    const textarea = document.querySelector('.edit-textarea') as HTMLTextAreaElement;
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'New mission');

    await userEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      const putCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => (c[1] as RequestInit)?.method === 'PUT'
      );
      expect(putCalls.length).toBe(1);
      expect(putCalls[0][0]).toContain('context/vision.yaml');
      const body = JSON.parse((putCalls[0][1] as RequestInit).body as string);
      expect(body.content).toContain('New mission');
    });
  });

  it('shows Save and Cancel buttons in edit mode', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Mission Statement')).toBeInTheDocument());

    const editBtns = document.querySelectorAll('.edit-btn');
    await userEvent.click(editBtns[0]);

    expect(screen.getByText('Save')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });
});

describe('Personas edit mode', () => {
  async function openUsersTab() {
    render(<App />);
    await userEvent.click(screen.getByText('Users & Stories'));
    await waitFor(() => expect(screen.getByText(/Alex — Product Owner/)).toBeInTheDocument());
  }

  it('clicking Edit shows form fields for persona', async () => {
    await openUsersTab();

    const editBtns = document.querySelectorAll('.edit-btn');
    await userEvent.click(editBtns[0]);

    await waitFor(() => {
      expect(document.querySelector('.edit-form')).toBeInTheDocument();
      const inputs = document.querySelectorAll('.edit-input');
      expect(inputs.length).toBeGreaterThanOrEqual(2); // name, title, quote
    });
  });

  it('Cancel reverts persona edit without API call', async () => {
    await openUsersTab();

    const editBtns = document.querySelectorAll('.edit-btn');
    await userEvent.click(editBtns[0]);
    expect(document.querySelector('.edit-form')).toBeInTheDocument();

    const fetchCallsBefore = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await userEvent.click(screen.getByText('Cancel'));

    expect(document.querySelector('.edit-form')).not.toBeInTheDocument();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(fetchCallsBefore);
  });

  it('Save sends PUT with updated persona data', async () => {
    await openUsersTab();

    const editBtns = document.querySelectorAll('.edit-btn');
    await userEvent.click(editBtns[0]);

    // Change the name field (first input)
    const nameInput = document.querySelectorAll('.edit-input')[0] as HTMLInputElement;
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Alexandra');

    await userEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      const putCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => (c[1] as RequestInit)?.method === 'PUT'
      );
      expect(putCalls.length).toBe(1);
      expect(putCalls[0][0]).toContain('context/personas.yaml');
      const body = JSON.parse((putCalls[0][1] as RequestInit).body as string);
      expect(body.content).toContain('Alexandra');
    });
  });
});

describe('Design (markdown) edit mode', () => {
  async function openDesignTab() {
    render(<App />);
    await userEvent.click(screen.getByText('Design'));
    await waitFor(() => expect(screen.getByText(/Speed over features/)).toBeInTheDocument());
  }

  it('clicking Edit shows textarea with raw markdown', async () => {
    await openDesignTab();

    await userEvent.click(screen.getByText('Edit'));

    const textarea = document.querySelector('.edit-textarea') as HTMLTextAreaElement;
    expect(textarea).toBeInTheDocument();
    expect(textarea.value).toContain('# Design');
    expect(textarea.value).toContain('Speed over features');
  });

  it('Cancel hides textarea without API call', async () => {
    await openDesignTab();
    await userEvent.click(screen.getByText('Edit'));
    expect(document.querySelector('.edit-textarea')).toBeInTheDocument();

    const fetchCallsBefore = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await userEvent.click(screen.getByText('Cancel'));

    expect(document.querySelector('.edit-textarea')).not.toBeInTheDocument();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(fetchCallsBefore);
  });

  it('Save sends PUT with updated markdown', async () => {
    await openDesignTab();
    await userEvent.click(screen.getByText('Edit'));

    const textarea = document.querySelector('.edit-textarea') as HTMLTextAreaElement;
    await userEvent.clear(textarea);
    await userEvent.type(textarea, '# Updated Design');

    await userEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      const putCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => (c[1] as RequestInit)?.method === 'PUT'
      );
      expect(putCalls.length).toBe(1);
      expect(putCalls[0][0]).toContain('product/design.md');
      const body = JSON.parse((putCalls[0][1] as RequestInit).body as string);
      expect(body.content).toBe('# Updated Design');
    });
  });
});

describe('Architecture (markdown) edit mode', () => {
  it('Edit/Save works for architecture markdown', async () => {
    render(<App />);
    await userEvent.click(screen.getByText('Architecture'));
    await waitFor(() => expect(screen.getByText(/No ORMs/)).toBeInTheDocument());

    await userEvent.click(screen.getByText('Edit'));
    const textarea = document.querySelector('.edit-textarea') as HTMLTextAreaElement;
    expect(textarea.value).toContain('# Architecture');

    await userEvent.clear(textarea);
    await userEvent.type(textarea, '# New Arch');
    await userEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      const putCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => (c[1] as RequestInit)?.method === 'PUT'
      );
      expect(putCalls.length).toBe(1);
      expect(putCalls[0][0]).toContain('product/architecture.md');
    });
  });
});

describe('Glossary edit mode', () => {
  async function openGlossaryTab() {
    render(<App />);
    await userEvent.click(screen.getByText('Glossary'));
    await waitFor(() => expect(screen.getByText('Project')).toBeInTheDocument());
  }

  it('clicking Edit shows inline inputs for term', async () => {
    await openGlossaryTab();

    const editBtns = document.querySelectorAll('.edit-btn');
    await userEvent.click(editBtns[0]);

    await waitFor(() => {
      const input = document.querySelector('.edit-input') as HTMLInputElement;
      expect(input).toBeInTheDocument();
      expect(input.value).toBe('Project');
    });
  });

  it('Save sends PUT with updated glossary', async () => {
    await openGlossaryTab();

    const editBtns = document.querySelectorAll('.edit-btn');
    await userEvent.click(editBtns[0]);

    const input = document.querySelector('.edit-input') as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, 'Repository');

    await userEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      const putCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => (c[1] as RequestInit)?.method === 'PUT'
      );
      expect(putCalls.length).toBe(1);
      expect(putCalls[0][0]).toContain('product/glossary.yaml');
      const body = JSON.parse((putCalls[0][1] as RequestInit).body as string);
      expect(body.content).toContain('Repository');
    });
  });
});

describe('Roadmap edit mode', () => {
  async function openRoadmapTab() {
    render(<App />);
    await userEvent.click(screen.getByText('Roadmap'));
    await waitFor(() => expect(screen.getByText('Static mockup')).toBeInTheDocument());
  }

  it('clicking Edit shows input and status dropdown for milestone', async () => {
    await openRoadmapTab();

    const editBtns = document.querySelectorAll('.edit-btn');
    await userEvent.click(editBtns[0]);

    await waitFor(() => {
      const input = document.querySelector('.edit-input') as HTMLInputElement;
      expect(input).toBeInTheDocument();
      expect(input.value).toBe('Static mockup');

      const select = document.querySelector('.edit-select') as HTMLSelectElement;
      expect(select).toBeInTheDocument();
      expect(select.value).toBe('done');
    });
  });

  it('Save sends PUT with updated roadmap', async () => {
    await openRoadmapTab();

    const editBtns = document.querySelectorAll('.edit-btn');
    await userEvent.click(editBtns[0]);

    const input = document.querySelector('.edit-input') as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, 'Updated mockup');

    await userEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      const putCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => (c[1] as RequestInit)?.method === 'PUT'
      );
      expect(putCalls.length).toBe(1);
      expect(putCalls[0][0]).toContain('delivery/roadmap.yaml');
      const body = JSON.parse((putCalls[0][1] as RequestInit).body as string);
      expect(body.content).toContain('Updated mockup');
    });
  });
});
