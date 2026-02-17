import { useState, useEffect } from 'react';
import { fetchFile } from './api';

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

  const activeItem = TABS.flatMap(s => s.items).find(i => i.id === activeTab)!;

  useEffect(() => {
    setLoading(true);
    setError(null);
    setFileData(null);
    fetchFile(activeItem.file)
      .then(setFileData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [activeTab]);

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
            <FileView id={activeTab} label={activeItem.label} filePath={activeItem.file} data={fileData} />
          )}
        </div>
      </div>
    </>
  );
}

function FileView({ id, label, filePath, data }: { id: string; label: string; filePath: string; data: FileData }) {
  const isYaml = filePath.endsWith('.yaml') || filePath.endsWith('.yml');
  const isMd = filePath.endsWith('.md');
  const parsed = data.data;

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
        {label}
        <span className="file-ref">{filePath}</span>
      </h2>

      {id === 'vision' && isYaml && <VisionView data={parsed as VisionData} />}
      {id === 'users' && isYaml && <PersonasView data={parsed as PersonasData} />}
      {id === 'glossary' && isYaml && <GlossaryView data={parsed as GlossaryData} />}
      {id === 'roadmap' && isYaml && <RoadmapView data={parsed as RoadmapData} />}
      {isMd && <MarkdownView raw={data.raw} />}
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

function VisionView({ data }: { data: VisionData }) {
  if (!data?.mission) return null;
  return (
    <>
      <Section title="Mission Statement" ctx="All agents" file="context/vision.yaml">
        <p>{data.mission}</p>
      </Section>
      <Section title="Product Vision Summary" ctx="All agents" file="context/vision.yaml">
        <p>{data.vision}</p>
      </Section>
      <Section title="What We Are" ctx="All agents" file="context/vision.yaml">
        <p>{data.what_we_are}</p>
      </Section>
      <Section title="What We Are Not" ctx="All agents" file="context/vision.yaml">
        <ul>
          {data.what_we_are_not.map((item, i) => <li key={i}>{item}</li>)}
        </ul>
      </Section>
    </>
  );
}

// ── Personas ──
interface Persona { id: string; name: string; title: string; tier: string; background: string; quote?: string; }
interface PersonasData { personas: Persona[] }

function PersonasView({ data }: { data: PersonasData }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  if (!data?.personas) return null;
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
            <button className="edit-btn" onClick={e => e.stopPropagation()}>Edit</button>
          </div>
          {!collapsed[p.id] && (
            <div className="section-body">
              <p>{p.background}</p>
              {p.quote && <p style={{ fontStyle: 'italic', color: 'var(--text-3)', marginTop: 8 }}>"{p.quote}"</p>}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

// ── Glossary ──
interface GlossaryData { terms: { term: string; definition: string }[] }

function GlossaryView({ data }: { data: GlossaryData }) {
  if (!data?.terms) return null;
  return (
    <>
      <p style={{ color: 'var(--text-3)', fontSize: 13, marginBottom: 16 }}>
        Shared vocabulary. Agents must use these terms consistently.
      </p>
      <div className="section">
        <div className="section-body" style={{ padding: 0 }}>
          {data.terms.map((t, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '140px 1fr', borderBottom: i < data.terms.length - 1 ? '1px solid var(--border-s)' : 'none' }}>
              <div style={{ padding: '10px 16px', fontWeight: 600, color: 'var(--accent)' }}>{t.term}</div>
              <div style={{ padding: '10px 16px', color: 'var(--text-2)', fontSize: 13 }}>{t.definition}</div>
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

function RoadmapView({ data }: { data: RoadmapData }) {
  if (!data?.workstreams) return null;
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
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{ms.title}</div>
              </div>
              <span className={`pill ${STATUS_PILL[ms.status] || 'pill-gray'}`}>
                {ms.status.replace('_', ' ')}
              </span>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

// ── Markdown (raw for now) ──
function MarkdownView({ raw }: { raw: string }) {
  return (
    <div className="section">
      <div className="section-body" style={{ fontFamily: "'SF Mono', monospace", fontSize: 12, whiteSpace: 'pre-wrap' }}>
        {raw}
      </div>
    </div>
  );
}

// ── Shared section wrapper ──
function Section({ title, ctx, file, children }: { title: string; ctx?: string; file?: string; children: React.ReactNode }) {
  return (
    <div className="section">
      <div className="section-head">
        {title}
        {ctx && <span className="ctx">{ctx}</span>}
        <span className="spacer" />
        {file && <span className="file-ref">{file}</span>}
        <button className="edit-btn">Edit</button>
      </div>
      <div className="section-body">{children}</div>
    </div>
  );
}

export default App;
