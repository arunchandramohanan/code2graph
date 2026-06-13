import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useApp } from '../context/AppContext';
import GraphCanvas from '../components/GraphCanvas';
import { LabelBadge, StackBadge } from '../components/Badges';

function NodePicker({ value, onPick }) {
  const { project } = useApp();
  const [q, setQ] = useState('');
  const [options, setOptions] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    clearTimeout(timerRef.current);
    if (!q.trim()) {
      setOptions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    timerRef.current = setTimeout(async () => {
      const reqId = ++reqIdRef.current;
      try {
        const params = { q: q.trim(), limit: 15 };
        if (project) params.project = project;
        const res = await api.search(params);
        if (reqId !== reqIdRef.current) return;
        setOptions(Array.isArray(res) ? res : []);
        setOpen(true);
      } catch {
        if (reqId !== reqIdRef.current) return;
        setOptions([]);
      } finally {
        if (reqId === reqIdRef.current) setLoading(false);
      }
    }, 300);
    return () => clearTimeout(timerRef.current);
  }, [q, project]);

  return (
    <div className="node-picker">
      <input
        className="input mono"
        placeholder={value ? value : 'Type to search for a node…'}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => options.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
      />
      {loading && <div className="picker-hint muted">searching…</div>}
      {open && options.length > 0 && (
        <div className="picker-dropdown">
          {options.map((n) => (
            <button
              key={n.id}
              className="picker-option"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(n);
                setQ('');
                setOpen(false);
              }}
            >
              <LabelBadge label={n.label} />
              <span>{n.name}</span>
              <span className="mono muted ellipsis">{n.fqn}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ImpactPage() {
  const { pushToast } = useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();

  const nodeId = searchParams.get('node') || '';
  const [nodeMeta, setNodeMeta] = useState(() =>
    location.state && location.state.nodeName
      ? { name: location.state.nodeName, label: location.state.nodeLabel }
      : null
  );
  const [direction, setDirection] = useState('both');
  const [depth, setDepth] = useState(3);
  const [graph, setGraph] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Resolve a display name for the chosen node if we landed here via URL only.
  useEffect(() => {
    if (!nodeId) {
      setNodeMeta(null);
      return;
    }
    if (nodeMeta && nodeMeta.id === nodeId) return;
    let cancelled = false;
    api
      .node(nodeId)
      .then((d) => {
        if (!cancelled && d && d.node) {
          setNodeMeta({ id: nodeId, name: d.node.name, label: d.node.label });
        }
      })
      .catch(() => {
        if (!cancelled) setNodeMeta({ id: nodeId, name: nodeId, label: '' });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  const run = useCallback(async () => {
    if (!nodeId) return;
    setLoading(true);
    setError(null);
    try {
      const g = await api.impact(nodeId, { direction, depth });
      setGraph({ nodes: (g && g.nodes) || [], edges: (g && g.edges) || [] });
    } catch (err) {
      setError(err.message);
      setGraph(null);
    } finally {
      setLoading(false);
    }
  }, [nodeId, direction, depth]);

  useEffect(() => {
    run();
  }, [run]);

  const nodes = (graph && graph.nodes) || [];
  const affected = nodes.filter((n) => n.id !== nodeId);

  const byDistance = {};
  affected.forEach((n) => {
    const d = typeof n.distance === 'number' ? n.distance : '?';
    if (!byDistance[d]) byDistance[d] = [];
    byDistance[d].push(n);
  });
  const distances = Object.keys(byDistance).sort((a, b) => {
    if (a === '?') return 1;
    if (b === '?') return -1;
    return Number(a) - Number(b);
  });

  return (
    <div className="page">
      <div className="page-header">
        <h1>Impact Analysis</h1>
      </div>

      <div className="impact-controls">
        <div className="field" style={{ flex: 1, minWidth: 280 }}>
          <span className="field-label">Node</span>
          <NodePicker
            value={nodeMeta ? nodeMeta.name : nodeId}
            onPick={(n) => {
              setNodeMeta({ id: n.id, name: n.name, label: n.label });
              setSearchParams({ node: n.id });
            }}
          />
          {nodeId && (
            <div className="mono muted small ellipsis" title={nodeId}>{nodeId}</div>
          )}
        </div>
        <label className="field">
          <span className="field-label">Direction</span>
          <select className="select" value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="upstream">upstream (what depends on it)</option>
            <option value="downstream">downstream (what it depends on)</option>
            <option value="both">both</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Depth: {depth}</span>
          <input
            type="range"
            min="1"
            max="6"
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value))}
          />
        </label>
        <button className="btn btn-primary" onClick={run} disabled={!nodeId || loading}>
          {loading ? 'Analyzing…' : 'Analyze'}
        </button>
      </div>

      {!nodeId && (
        <div className="empty-box">Pick a node above to run an impact analysis.</div>
      )}
      {error && (
        <div className="error-box">
          {error}
          <button className="btn btn-small" onClick={run}>Retry</button>
        </div>
      )}

      {graph && !error && (
        <>
          <div className="impact-headline">
            <span className="impact-count">{affected.length}</span> nodes affected
            {nodeMeta && (
              <span className="muted">
                {' '}— {direction} of <strong>{nodeMeta.name}</strong> (depth {depth})
              </span>
            )}
          </div>

          <div className="impact-graph">
            <GraphCanvas
              graph={graph}
              selectedId={nodeId}
              onNodeClick={() => {}}
              onNodeDblClick={(d) => navigate(`/graph?focus=${encodeURIComponent(d.id)}`)}
              emptyMessage="No affected nodes found."
            />
          </div>

          {distances.map((d) => (
            <section key={d} className="section">
              <h3 className="distance-head">
                {d === '?' ? 'Unknown distance' : `${d} hop${Number(d) > 1 ? 's' : ''}`}
                <span className="muted"> · {byDistance[d].length}</span>
              </h3>
              <table className="data-table">
                <tbody>
                  {byDistance[d].map((n) => (
                    <tr
                      key={n.id}
                      className="row-clickable"
                      onClick={() => navigate(`/graph?focus=${encodeURIComponent(n.id)}`)}
                    >
                      <td>{n.name}</td>
                      <td><LabelBadge label={n.label} /></td>
                      <td><StackBadge stack={n.stack} /></td>
                      <td className="mono muted">{n.filePath || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
