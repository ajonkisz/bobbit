import { useState, useEffect } from 'react';
import yaml from 'js-yaml';
import { fetchFile, saveFile } from './api';

const TABS = [
  { section: 'Context', items: [
    { id: 'vision', label: 'Vision', file: 'context/vision.yaml' },
    { id: 'users', label: 'Users & Stories', file: 'context/personas.yaml' },
  ]},
  { section: 'Product', items: [
    { id: 'design', label: 'Design', file: 'product/design.md' },
    { id: 'architecture', label: 'Architecture', file: 'product/architecture.md' },
    { id: 'glossary', label: 'Glossary', file: 'product/glossary.yaml' },
  ]},
  { section: 'Delivery', items: [
    { id: 'roadmap', label: 'Roadmap', file: 'delivery/roadmap.yaml' },
  ]},
];

interface FileData {
  data: unknown;
  raw: string;
  path: string;
}

// ── Theme toggle — light default (Stripe style), dark on toggle ──
function ThemeToggle() {
  const [dark, setDark] = useState(() => {
    try {
      return localStorage.getItem('bobbit-theme') === 'dark';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try { localStorage.setItem('bobbit-theme', dark ? 'dark' : 'light'); } catch {}
  }, [dark]);

  return (
    <button className="theme-toggle" onClick={() => setDark(d => !d)} title={dark ? 'Switch to light mode' : 'Switch to dark mode'}>
      {dark ? '\u2600' : '\u263E'}
    </button>
  );
}

// ── Agent context descriptions per file ──
const FILE_CONTEXT: Record<string, { label: string; description: string }> = {
  'context/vision.yaml': { label: 'All agents', description: 'Injected into every agent\'s context window' },
  'context/personas.yaml': { label: 'Design agents', description: 'Injected into the context for Product Designer, Product Owner, and Architect agents' },
  'product/design.md': { label: 'Design agents', description: 'Guides visual and interaction patterns' },
  'product/architecture.md': { label: 'Engineering agents', description: 'Informs technical implementation decisions' },
  'product/glossary.yaml': { label: 'All agents', description: 'Ensures consistent terminology across tasks' },
  'delivery/roadmap.yaml': { label: 'Planning agents', description: 'Drives prioritization and scheduling' },
};

// ── Neon context icons per agent scope ──
const CONTEXT_ICONS: Record<string, JSX.Element> = {
  'All agents': (
    <svg viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0C8 4.4 4.4 8 0 8c4.4 0 8 3.6 8 8 0-4.4 3.6-8 8-8-4.4 0-8-3.6-8-8Z"/>
    </svg>
  ),
  'Design agents': (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.5 1.5l3 3-9 9-4 1 1-4Z"/>
    </svg>
  ),
  'Engineering agents': (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3L1 8l4 5M11 3l4 5-4 5"/>
    </svg>
  ),
  'Planning agents': (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 1v14M3 2.5c4-2 8 2 11 0v7c-4 2-7-2-11 0"/>
    </svg>
  ),
};

const PAGE_ICONS: Record<string, JSX.Element> = {
  /* vision: uses default from CONTEXT_ICONS['All agents'] */
  users: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="5" r="2.5"/>
      <path d="M1.5 14c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5"/>
      <circle cx="11.5" cy="5.5" r="2"/>
      <path d="M11.5 9c1.9 0 3.5 1.6 3.5 3.5"/>
    </svg>
  ),
  design: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 14l2-6 6-6 4 4-6 6z"/>
      <path d="M10 4l2 2"/>
      <path d="M4 8l4 4"/>
      <circle cx="3" cy="13" r="1" fill="currentColor" stroke="none"/>
    </svg>
  ),
  architecture: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3L1 8l4 5M11 3l4 5-4 5"/>
    </svg>
  ),
  glossary: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 2h10a2 2 0 012 2v8a2 2 0 01-2 2H2"/>
      <path d="M2 2v12"/>
      <path d="M5 6h5"/>
      <path d="M5 9h3"/>
    </svg>
  ),
  roadmap: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 14c2-2 4 0 6-3s2-5 6-7"/>
      <circle cx="2" cy="14" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="14" cy="4" r="1.5" fill="currentColor" stroke="none"/>
    </svg>
  ),
};

// ── Icon + heading wrapper with hover popover ──
function InfoTooltip({ label, description, icon: iconOverride, children }: { label?: string; description?: string; icon?: JSX.Element; children?: React.ReactNode }) {
  if (!label) return <>{children}</>;
  const icon = iconOverride || CONTEXT_ICONS[label];
  return (
    <span className="ctx-hover-target">
      {icon && <span className="ctx-icon">{icon}</span>}
      {children}
      {description && (
        <span className="ctx-popover">
          <strong className="ctx-popover-label">{label}</strong>
          {description}
        </span>
      )}
    </span>
  );
}

// Logo — light colors for the always-dark nav
const LOGO_SVG = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" width="28" height="28">
    <path d="M16 2L28.66 9.5V24.5L16 32L3.34 24.5V9.5L16 2Z" fill="#635bff"/>
    <circle cx="16" cy="17" r="5" fill="#fff" fillOpacity="0.9"/>
    <circle cx="16" cy="17" r="2" fill="#635bff"/>
    <line x1="16" y1="12" x2="16" y2="7" stroke="#fff" strokeOpacity="0.6" strokeWidth="1.5" strokeLinecap="round"/>
    <line x1="20.33" y1="14.5" x2="24.33" y2="11.5" stroke="#fff" strokeOpacity="0.6" strokeWidth="1.5" strokeLinecap="round"/>
    <line x1="20.33" y1="19.5" x2="24.33" y2="22.5" stroke="#fff" strokeOpacity="0.6" strokeWidth="1.5" strokeLinecap="round"/>
    <line x1="16" y1="22" x2="16" y2="27" stroke="#fff" strokeOpacity="0.6" strokeWidth="1.5" strokeLinecap="round"/>
    <line x1="11.67" y1="19.5" x2="7.67" y2="22.5" stroke="#fff" strokeOpacity="0.6" strokeWidth="1.5" strokeLinecap="round"/>
    <line x1="11.67" y1="14.5" x2="7.67" y2="11.5" stroke="#fff" strokeOpacity="0.6" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

function App() {
  const [activeTab, setActiveTab] = useState('vision');
  const [fileData, setFileData] = useState<FileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const activeItem = TABS.flatMap(s => s.items).find(i => i.id === activeTab)!;

  useEffect(() => {
    setLoading(true);
    setError(null);
    setFileData(null);
    fetchFile(activeItem.file)
      .then(setFileData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [activeTab, refreshKey]);

  const refresh = () => setRefreshKey(k => k + 1);

  return (
    <>
      <div className="chrome">
        <span className="chrome-logo">{LOGO_SVG}</span>
        <span className="chrome-brand">Bobbit</span>
        <div className="spacer" />
        <div className="product-tabs">
          <button className="product-tab active">Bobbit</button>
          <button className="product-tab product-add" title="New project">+</button>
        </div>
        <ThemeToggle />
      </div>

      <div className="app-layout">
        <nav className="sidebar">
          {TABS.map(section => (
            <div key={section.section}>
              <div className="sidebar-section">{section.section}</div>
              {section.items.map(item => (
                <div
                  key={item.id}
                  className={`sidebar-item ${activeTab === item.id ? 'active' : ''}`}
                  onClick={() => setActiveTab(item.id)}
                >
                  {item.label}
                </div>
              ))}
            </div>
          ))}
        </nav>

        <div className="content">
          {loading && <div className="loading">Loading...</div>}
          {error && <div className="error">{error}</div>}
          {!loading && !error && fileData && (
            <FileView id={activeTab} label={activeItem.label} filePath={activeItem.file} data={fileData} onSaved={refresh} />
          )}
        </div>
      </div>
    </>
  );
}

function FileView({ id, label, filePath, data, onSaved }: { id: string; label: string; filePath: string; data: FileData; onSaved: () => void }) {
  const isYaml = filePath.endsWith('.yaml') || filePath.endsWith('.yml');
  const isMd = filePath.endsWith('.md');
  const parsed = data.data;

  return (
    <div>
      <h2 style={{ fontSize: 25, fontWeight: 700, marginBottom: 20, letterSpacing: '-0.3px', display: 'flex', alignItems: 'center' }}>
        <InfoTooltip label={FILE_CONTEXT[filePath]?.label} description={FILE_CONTEXT[filePath]?.description} icon={PAGE_ICONS[id]}>
          {label}
        </InfoTooltip>
      </h2>

      {id === 'vision' && isYaml && <VisionView data={parsed as VisionData} fullData={parsed as VisionData} filePath={filePath} onSaved={onSaved} />}
      {id === 'users' && isYaml && <PersonasView data={parsed as PersonasData} filePath={filePath} onSaved={onSaved} />}
      {id === 'glossary' && isYaml && <GlossaryView data={parsed as GlossaryData} filePath={filePath} onSaved={onSaved} />}
      {id === 'roadmap' && isYaml && <RoadmapView data={parsed as RoadmapData} filePath={filePath} onSaved={onSaved} />}
      {isMd && <MarkdownView raw={data.raw} filePath={filePath} onSaved={onSaved} />}
    </div>
  );
}

// ── Vision ──
interface VisionData {
  mission: string;
  vision: string;
  what_we_are: string;
  what_we_are_not: string[];
}

type VisionField = 'mission' | 'vision' | 'what_we_are' | 'what_we_are_not';

const MISSION_ICON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 15l5-9 3 5 2-3 4 7H1z"/>
    <path d="M6 6V2"/>
    <path d="M6 2l3 1.5L6 4.5"/>
  </svg>
);

const VISION_ICON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="8" cy="8" r="3"/>
    <path d="M1 8c2-4 5-6 7-6s5 2 7 6c-2 4-5 6-7 6s-5-2-7-6z"/>
  </svg>
);

const WHAT_WE_ARE_ICON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="8" cy="8" r="5"/>
    <path d="M8 3V1"/>
    <path d="M8 15v-2"/>
    <path d="M3 8H1"/>
    <path d="M15 8h-2"/>
    <path d="M12.5 8A4.5 4.5 0 008 3.5"/>
  </svg>
);

const WHAT_WE_ARE_NOT_ICON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="8" cy="8" r="6.5"/>
    <path d="M3.4 3.4l9.2 9.2"/>
  </svg>
);

const VISION_SECTIONS: { field: VisionField; title: string; icon?: JSX.Element }[] = [
  { field: 'mission', title: 'Mission Statement', icon: MISSION_ICON },
  { field: 'vision', title: 'Product Vision Summary', icon: VISION_ICON },
  { field: 'what_we_are', title: 'This Product Is', icon: WHAT_WE_ARE_ICON },
  { field: 'what_we_are_not', title: 'This Product Is Not', icon: WHAT_WE_ARE_NOT_ICON },
];

function VisionView({ data, fullData, filePath, onSaved }: { data: VisionData; fullData: VisionData; filePath: string; onSaved: () => void }) {
  const [editing, setEditing] = useState<VisionField | null>(null);
  const [editBuffer, setEditBuffer] = useState('');
  const [saving, setSaving] = useState(false);

  if (!data?.mission) return null;

  const startEdit = (field: VisionField) => {
    const val = data[field];
    setEditBuffer(Array.isArray(val) ? val.join('\n') : val);
    setEditing(field);
  };

  const cancelEdit = () => { setEditing(null); setEditBuffer(''); };

  const handleSave = async (field: VisionField) => {
    setSaving(true);
    try {
      const updated = { ...fullData };
      if (field === 'what_we_are_not') {
        updated[field] = editBuffer.split('\n').map(s => s.trim()).filter(Boolean);
      } else {
        updated[field] = editBuffer;
      }
      await saveFile(filePath, yaml.dump(updated, { lineWidth: -1 }));
      setEditing(null);
      setEditBuffer('');
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {VISION_SECTIONS.map(({ field, title, icon }) => (
        <Section
          key={field}
          title={title}
          ctxLabel="All agents"
          ctxDescription="Injected into every agent's context window"
          icon={icon}
          editing={editing === field}
          onEdit={() => startEdit(field)}
          onCancel={cancelEdit}
          onSave={() => handleSave(field)}
          saving={saving}
        >
          {editing === field ? (
            <textarea
              className="edit-textarea"
              value={editBuffer}
              onChange={e => setEditBuffer(e.target.value)}
              rows={field === 'what_we_are_not' ? 6 : 4}
            />
          ) : (
            field === 'what_we_are_not' ? (
              <ul style={{ paddingLeft: 20, margin: 0 }}>{data.what_we_are_not.map((item, i) => <li key={i}>{item}</li>)}</ul>
            ) : (
              <p>{data[field]}</p>
            )
          )}
        </Section>
      ))}
    </>
  );
}

// ── Personas ──
interface Persona { id: string; name: string; title: string; tier: string; background: string; quote?: string; }
interface PersonasData { personas: Persona[] }

function PersonasView({ data, filePath, onSaved }: { data: PersonasData; filePath: string; onSaved: () => void }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Persona | null>(null);
  const [saving, setSaving] = useState(false);

  if (!data?.personas) return null;

  const startEdit = (p: Persona) => {
    setEditingId(p.id);
    setEditForm({ ...p });
  };

  const cancelEdit = () => { setEditingId(null); setEditForm(null); };

  const handleSave = async () => {
    if (!editForm) return;
    setSaving(true);
    try {
      const updated = {
        ...data,
        personas: data.personas.map(p => p.id === editForm.id ? editForm : p),
      };
      await saveFile(filePath, yaml.dump(updated, { lineWidth: -1 }));
      setEditingId(null);
      setEditForm(null);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const updateField = (field: keyof Persona, value: string) => {
    setEditForm(f => f ? { ...f, [field]: value } : f);
  };

  return (
    <>
      <p style={{ color: 'var(--text-3)', fontSize: 14, marginBottom: 16 }}>
        Personas and their context. Shapes user-centered design decisions.
      </p>
      {data.personas.map(p => (
        <div className="section" key={p.id}>
          <div className="section-head" style={{ cursor: 'pointer' }} onClick={() => setCollapsed(c => ({ ...c, [p.id]: !c[p.id] }))}>
            {p.name} — {p.title}
            <span className={`pill pill-${p.tier === 'primary' ? 'green' : p.tier === 'secondary' ? 'blue' : 'gray'}`}>
              {p.tier}
            </span>
            <span className="spacer" />
            {editingId === p.id ? (
              <span className="edit-actions" onClick={e => e.stopPropagation()}>
                <button className="save-btn" onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
                <button className="cancel-btn" onClick={cancelEdit}>Cancel</button>
              </span>
            ) : (
              <button className="edit-btn" onClick={e => { e.stopPropagation(); startEdit(p); }}>Edit</button>
            )}
          </div>
          {!collapsed[p.id] && (
            <div className="section-body">
              {editingId === p.id && editForm ? (
                <div className="edit-form">
                  <label className="edit-label">Name
                    <input className="edit-input" value={editForm.name} onChange={e => updateField('name', e.target.value)} />
                  </label>
                  <label className="edit-label">Title
                    <input className="edit-input" value={editForm.title} onChange={e => updateField('title', e.target.value)} />
                  </label>
                  <label className="edit-label">Tier
                    <select className="edit-select" value={editForm.tier} onChange={e => updateField('tier', e.target.value)}>
                      <option value="primary">primary</option>
                      <option value="secondary">secondary</option>
                      <option value="tertiary">tertiary</option>
                    </select>
                  </label>
                  <label className="edit-label">Background
                    <textarea className="edit-textarea" value={editForm.background} onChange={e => updateField('background', e.target.value)} rows={3} />
                  </label>
                  <label className="edit-label">Quote
                    <input className="edit-input" value={editForm.quote || ''} onChange={e => updateField('quote', e.target.value)} />
                  </label>
                </div>
              ) : (
                <>
                  <p>{p.background}</p>
                  {p.quote && <p style={{ fontStyle: 'italic', color: 'var(--text-3)', marginTop: 8 }}>"{p.quote}"</p>}
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

// ── Glossary ──
interface GlossaryData { terms: { term: string; definition: string }[] }

function GlossaryView({ data, filePath, onSaved }: { data: GlossaryData; filePath: string; onSaved: () => void }) {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editTerm, setEditTerm] = useState('');
  const [editDef, setEditDef] = useState('');
  const [saving, setSaving] = useState(false);

  if (!data?.terms) return null;

  const startEdit = (i: number) => {
    setEditingIdx(i);
    setEditTerm(data.terms[i].term);
    setEditDef(data.terms[i].definition);
  };

  const cancelEdit = () => { setEditingIdx(null); setEditTerm(''); setEditDef(''); };

  const handleSave = async () => {
    if (editingIdx === null) return;
    setSaving(true);
    try {
      const updated = {
        ...data,
        terms: data.terms.map((t, i) => i === editingIdx ? { term: editTerm, definition: editDef } : t),
      };
      await saveFile(filePath, yaml.dump(updated, { lineWidth: -1 }));
      setEditingIdx(null);
      setEditTerm('');
      setEditDef('');
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <p style={{ color: 'var(--text-3)', fontSize: 14, marginBottom: 16 }}>
        Shared vocabulary. Agents must use these terms consistently.
      </p>
      <div className="section">
        <div className="section-body" style={{ padding: 0 }}>
          {data.terms.map((t, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '140px 1fr auto', borderBottom: i < data.terms.length - 1 ? '1px solid var(--border-s)' : 'none' }}>
              {editingIdx === i ? (
                <>
                  <div style={{ padding: '10px 16px' }}>
                    <input className="edit-input" value={editTerm} onChange={e => setEditTerm(e.target.value)} />
                  </div>
                  <div style={{ padding: '10px 16px' }}>
                    <textarea className="edit-textarea" value={editDef} onChange={e => setEditDef(e.target.value)} rows={2} />
                  </div>
                  <div style={{ padding: '10px 16px', display: 'flex', gap: 6, alignItems: 'start' }}>
                    <button className="save-btn" onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
                    <button className="cancel-btn" onClick={cancelEdit}>Cancel</button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ padding: '10px 16px', fontWeight: 600, color: 'var(--accent)' }}>{t.term}</div>
                  <div style={{ padding: '10px 16px', color: 'var(--text-2)', fontSize: 14 }}>{t.definition}</div>
                  <div style={{ padding: '10px 16px' }}>
                    <button className="edit-btn" onClick={() => startEdit(i)}>Edit</button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ── Roadmap ──
interface Milestone { title: string; status: string }
interface Workstream { name: string; description?: string; milestones: Milestone[] }
interface RoadmapData { workstreams: Workstream[] }

const STATUS_PILL: Record<string, string> = {
  done: 'pill-green', in_progress: 'pill-yellow', review: 'pill-orange',
  planning: 'pill-blue', not_started: 'pill-gray', draft: 'pill-gray',
};

const STATUS_OPTIONS = ['not_started', 'planning', 'in_progress', 'review', 'done', 'draft'];

function RoadmapView({ data, filePath, onSaved }: { data: RoadmapData; filePath: string; onSaved: () => void }) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editStatus, setEditStatus] = useState('');
  const [saving, setSaving] = useState(false);

  if (!data?.workstreams) return null;

  const msKey = (wi: number, mi: number) => `${wi}-${mi}`;

  const startEdit = (wi: number, mi: number) => {
    const ms = data.workstreams[wi].milestones[mi];
    setEditingKey(msKey(wi, mi));
    setEditTitle(ms.title);
    setEditStatus(ms.status);
  };

  const cancelEdit = () => { setEditingKey(null); setEditTitle(''); setEditStatus(''); };

  const handleSave = async (wi: number, mi: number) => {
    setSaving(true);
    try {
      const updated = {
        ...data,
        workstreams: data.workstreams.map((ws, i) => i === wi ? {
          ...ws,
          milestones: ws.milestones.map((ms, j) => j === mi ? { title: editTitle, status: editStatus } : ms),
        } : ws),
      };
      await saveFile(filePath, yaml.dump(updated, { lineWidth: -1 }));
      setEditingKey(null);
      setEditTitle('');
      setEditStatus('');
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {data.workstreams.map((ws, i) => (
        <div key={i} style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid var(--border-s)' }}>
            <strong style={{ fontSize: 16, flex: 1 }}>{ws.name}</strong>
            {ws.description && <span style={{ fontSize: 13, color: 'var(--text-3)' }}>{ws.description}</span>}
          </div>
          {ws.milestones.map((ms, j) => (
            <div key={j} style={{
              background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 'var(--r)',
              padding: '12px 16px', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 12,
            }}>
              {editingKey === msKey(i, j) ? (
                <>
                  <input className="edit-input" style={{ flex: 1 }} value={editTitle} onChange={e => setEditTitle(e.target.value)} />
                  <select className="edit-select" value={editStatus} onChange={e => setEditStatus(e.target.value)}>
                    {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                  </select>
                  <button className="save-btn" onClick={() => handleSave(i, j)} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
                  <button className="cancel-btn" onClick={cancelEdit}>Cancel</button>
                </>
              ) : (
                <>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{ms.title}</div>
                  </div>
                  <span className={`pill ${STATUS_PILL[ms.status] || 'pill-gray'}`}>
                    {ms.status.replace('_', ' ')}
                  </span>
                  <button className="edit-btn" onClick={() => startEdit(i, j)}>Edit</button>
                </>
              )}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

// ── Markdown ──
function MarkdownView({ raw, filePath, onSaved }: { raw: string; filePath: string; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [editBuffer, setEditBuffer] = useState('');
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setEditBuffer(raw);
    setEditing(true);
  };

  const cancelEdit = () => { setEditing(false); setEditBuffer(''); };

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveFile(filePath, editBuffer);
      setEditing(false);
      setEditBuffer('');
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="section">
      <div className="section-head">
        {filePath.split('/').pop()}
        <span className="spacer" />
        {editing ? (
          <span className="edit-actions">
            <button className="save-btn" onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
            <button className="cancel-btn" onClick={cancelEdit}>Cancel</button>
          </span>
        ) : (
          <button className="edit-btn" onClick={startEdit}>Edit</button>
        )}
      </div>
      <div className="section-body" style={{ fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 13, whiteSpace: 'pre-wrap' }}>
        {editing ? (
          <textarea
            className="edit-textarea edit-textarea-full"
            value={editBuffer}
            onChange={e => setEditBuffer(e.target.value)}
            rows={20}
          />
        ) : (
          raw
        )}
      </div>
    </div>
  );
}

// ── Shared section wrapper ──
function Section({ title, ctxLabel, ctxDescription, icon, editing, onEdit, onCancel, onSave, saving, children }: {
  title: string;
  ctxLabel?: string;
  ctxDescription?: string;
  icon?: JSX.Element;
  editing?: boolean;
  onEdit?: () => void;
  onCancel?: () => void;
  onSave?: () => void;
  saving?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="section">
      <div className="section-head">
        <InfoTooltip label={ctxLabel} description={ctxDescription} icon={icon}>
          {title}
        </InfoTooltip>
        <span className="spacer" />
        {editing ? (
          <span className="edit-actions">
            <button className="save-btn" onClick={onSave} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
            <button className="cancel-btn" onClick={onCancel}>Cancel</button>
          </span>
        ) : (
          <button className="edit-btn" onClick={onEdit}>Edit</button>
        )}
      </div>
      <div className="section-body">{children}</div>
    </div>
  );
}

export default App;
