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
        <span className="chrome-brand">Bobbit</span>
        <div className="product-tabs">
          <button className="product-tab active">Bobbit</button>
          <button className="product-tab" style={{ borderStyle: 'dashed', fontSize: 14, padding: '5px 10px' }}>+</button>
        </div>
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
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
        {label}
        <span className="file-ref">{filePath}</span>
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

const VISION_SECTIONS: { field: VisionField; title: string }[] = [
  { field: 'mission', title: 'Mission Statement' },
  { field: 'vision', title: 'Product Vision Summary' },
  { field: 'what_we_are', title: 'What We Are' },
  { field: 'what_we_are_not', title: 'What We Are Not' },
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
      {VISION_SECTIONS.map(({ field, title }) => (
        <Section
          key={field}
          title={title}
          ctx="All agents"
          file="context/vision.yaml"
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
              <ul>{data.what_we_are_not.map((item, i) => <li key={i}>{item}</li>)}</ul>
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
      <p style={{ color: 'var(--text-3)', fontSize: 13, marginBottom: 16 }}>
        Personas and their context. <span className="ctx">Design agents</span>
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
      <p style={{ color: 'var(--text-3)', fontSize: 13, marginBottom: 16 }}>
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
                  <div style={{ padding: '10px 16px', color: 'var(--text-2)', fontSize: 13 }}>{t.definition}</div>
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
            <strong style={{ fontSize: 14, flex: 1 }}>{ws.name}</strong>
            {ws.description && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{ws.description}</span>}
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
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{ms.title}</div>
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
      <div className="section-body" style={{ fontFamily: "'SF Mono', monospace", fontSize: 12, whiteSpace: 'pre-wrap' }}>
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
function Section({ title, ctx, file, editing, onEdit, onCancel, onSave, saving, children }: {
  title: string;
  ctx?: string;
  file?: string;
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
        {title}
        {ctx && <span className="ctx">{ctx}</span>}
        <span className="spacer" />
        {file && <span className="file-ref">{file}</span>}
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
