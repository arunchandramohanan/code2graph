import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useApp } from '../context/AppContext';
import { NODE_LABELS } from '../constants';
import { LabelBadge, StackBadge } from '../components/Badges';
import ProjectSelect from '../components/ProjectSelect';

export default function SearchPage() {
  const { project } = useApp();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [labels, setLabels] = useState(new Set());
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searched, setSearched] = useState(false);
  const timerRef = useRef(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    clearTimeout(timerRef.current);
    if (!q.trim()) {
      setResults([]);
      setSearched(false);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    timerRef.current = setTimeout(async () => {
      const reqId = ++reqIdRef.current;
      try {
        const params = { q: q.trim(), limit: 50 };
        if (project) params.project = project;
        if (labels.size) params.labels = [...labels].join(',');
        const res = await api.search(params);
        if (reqId !== reqIdRef.current) return;
        setResults(Array.isArray(res) ? res : []);
        setError(null);
        setSearched(true);
      } catch (err) {
        if (reqId !== reqIdRef.current) return;
        setError(err.message);
        setResults([]);
        setSearched(true);
      } finally {
        if (reqId === reqIdRef.current) setLoading(false);
      }
    }, 300);
    return () => clearTimeout(timerRef.current);
  }, [q, project, labels]);

  const toggleLabel = (label) => {
    setLabels((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Search</h1>
        <ProjectSelect />
      </div>

      <input
        className="input search-input mono"
        placeholder="Search name, FQN or file path…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
      />

      <div className="chip-row chips-clickable">
        {NODE_LABELS.map((label) => (
          <button
            key={label}
            className={`chip chip-toggle${labels.has(label) ? ' chip-on' : ''}`}
            onClick={() => toggleLabel(label)}
          >
            {label}
          </button>
        ))}
      </div>

      {loading && <div className="loading">Searching…</div>}
      {error && <div className="error-box">{error}</div>}
      {!loading && !error && searched && results.length === 0 && (
        <div className="empty-box">No results for “{q}”.</div>
      )}

      {results.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Label</th>
              <th>Stack</th>
              <th>FQN</th>
              <th>File</th>
            </tr>
          </thead>
          <tbody>
            {results.map((n) => (
              <tr
                key={n.id}
                className="row-clickable"
                onClick={() => navigate(`/graph?focus=${encodeURIComponent(n.id)}`)}
                title="Open in Graph Explorer"
              >
                <td>{n.name}</td>
                <td><LabelBadge label={n.label} /></td>
                <td><StackBadge stack={n.stack} /></td>
                <td className="mono ellipsis" style={{ maxWidth: 380 }}>{n.fqn}</td>
                <td className="mono muted">
                  {n.filePath ? `${n.filePath}${n.startLine ? `:${n.startLine}` : ''}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
