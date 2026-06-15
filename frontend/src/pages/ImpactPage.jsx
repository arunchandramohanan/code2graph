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

function DistanceTables({ nodes, seedIds, navigate }) {
  const seedSet = new Set(seedIds);
  const affected = nodes.filter((n) => !seedSet.has(n.id));
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
  return distances.map((d) => (
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
  ));
}

export default function ImpactPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();

  const launchBlast = searchParams.get('mode') === 'blast';
  const [mode, setMode] = useState(launchBlast ? 'blast' : 'impact'); // 'impact' | 'blast'

  // --- shared ---
  const [depth, setDepth] = useState(3);
  const [graph, setGraph] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // --- impact mode ---
  const nodeId = searchParams.get('node') || '';
  const [nodeMeta, setNodeMeta] = useState(() =>
    location.state && location.state.nodeName
      ? { name: location.state.nodeName, label: location.state.nodeLabel }
      : null
  );
  const [direction, setDirection] = useState('both');

  // --- blast mode ---
  const [seeds, setSeeds] = useState(() => {
    const id = searchParams.get('node');
    if (!launchBlast || !id) return [];
    const st = location.state || {};
    return [{ id, name: st.nodeName || id, label: st.nodeLabel || '' }];
  }); // [{id,name,label}]
  const [cypher, setCypher] = useState('');
  const [showCypher, setShowCypher] = useState(false);
  const [blast, setBlast] = useState(null); // { seeds, entryPoints, counts }

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
    if (mode !== 'impact') return;
    run();
  }, [run, mode]);

  const runBlast = useCallback(async () => {
    const seedIds = seeds.map((s) => s.id);
    if (!seedIds.length && !cypher.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.blastRadius({
        seeds: seedIds,
        cypher: cypher.trim() || null,
        depth,
      });
      setGraph({ nodes: (res && res.nodes) || [], edges: (res && res.edges) || [] });
      setBlast(res || null);
    } catch (err) {
      setError(err.message);
      setGraph(null);
      setBlast(null);
    } finally {
      setLoading(false);
    }
  }, [seeds, cypher, depth]);

  // Auto-run once when arriving from a node's "Blast radius" button.
  const autoRanRef = useRef(false);
  useEffect(() => {
    if (autoRanRef.current) return;
    if (mode === 'blast' && seeds.length) {
      autoRanRef.current = true;
      runBlast();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, seeds, runBlast]);

  const switchMode = (next) => {
    if (next === mode) return;
    setMode(next);
    setGraph(null);
    setBlast(null);
    setError(null);
  };

  const addSeed = (n) => {
    setSeeds((prev) => (prev.some((s) => s.id === n.id) ? prev : [...prev, n]));
  };
  const removeSeed = (id) => setSeeds((prev) => prev.filter((s) => s.id !== id));

  const nodes = (graph && graph.nodes) || [];
  const affectedImpact = nodes.filter((n) => n.id !== nodeId);
  const blastSeedIds = (blast && blast.seeds ? blast.seeds.map((s) => s.id) : seeds.map((s) => s.id));

  return (
    <div className="page">
      <div className="page-header">
        <h1>Impact Analysis</h1>
        <div className="seg-toggle">
          <button
            className={`btn btn-small${mode === 'impact' ? ' active' : ''}`}
            onClick={() => switchMode('impact')}
          >
            Impact
          </button>
          <button
            className={`btn btn-small${mode === 'blast' ? ' active' : ''}`}
            onClick={() => switchMode('blast')}
          >
            Blast radius
          </button>
        </div>
      </div>

      {mode === 'impact' && (
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
      )}

      {mode === 'blast' && (
        <div className="impact-controls blast-controls">
          <div className="field" style={{ flex: 1, minWidth: 280 }}>
            <span className="field-label">Vulnerable class(es)</span>
            <NodePicker value="" onPick={addSeed} />
            {seeds.length > 0 && (
              <div className="seed-chips">
                {seeds.map((s) => (
                  <span key={s.id} className="seed-chip" title={s.id}>
                    <LabelBadge label={s.label} />
                    <span className="ellipsis">{s.name}</span>
                    <button className="chip-x" onClick={() => removeSeed(s.id)} title="Remove">×</button>
                  </span>
                ))}
              </div>
            )}
            <button
              className="btn btn-small btn-link"
              onClick={() => setShowCypher((v) => !v)}
            >
              {showCypher ? '− Hide query' : '+ Select by query (advanced)'}
            </button>
            {showCypher && (
              <div className="cypher-field">
                <textarea
                  className="input mono"
                  rows={3}
                  placeholder={"Read-only Cypher returning vulnerable nodes, e.g.\nMATCH (n:CodeNode) WHERE 'log4j' IN coalesce(n.imports, []) RETURN n"}
                  value={cypher}
                  onChange={(e) => setCypher(e.target.value)}
                />
                <div className="muted small">
                  Results must carry node ids (return a node, or a column named <span className="mono">id</span>).
                </div>
              </div>
            )}
          </div>
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
          <button
            className="btn btn-primary"
            onClick={runBlast}
            disabled={loading || (!seeds.length && !cypher.trim())}
          >
            {loading ? 'Analyzing…' : 'Compute blast radius'}
          </button>
        </div>
      )}

      {mode === 'impact' && !nodeId && (
        <div className="empty-box">Pick a node above to run an impact analysis.</div>
      )}
      {mode === 'blast' && !seeds.length && !cypher.trim() && !blast && (
        <div className="empty-box">
          Pick the vulnerable class(es) above (or select by query) to compute the blast radius.
        </div>
      )}
      {error && (
        <div className="error-box">
          {error}
          <button className="btn btn-small" onClick={mode === 'blast' ? runBlast : run}>Retry</button>
        </div>
      )}

      {mode === 'impact' && graph && !error && (
        <>
          <div className="impact-headline">
            <span className="impact-count">{affectedImpact.length}</span> nodes affected
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

          <DistanceTables nodes={nodes} seedIds={[nodeId]} navigate={navigate} />
        </>
      )}

      {mode === 'blast' && blast && !error && (
        <>
          <div className="impact-headline">
            <span className="impact-count">{blast.counts.affected}</span> nodes in the blast radius
            <span className="muted">
              {' '}— upstream of {blast.seeds.length} vulnerable class
              {blast.seeds.length === 1 ? '' : 'es'} (depth {depth})
            </span>
          </div>

          <section className="section entrypoint-panel">
            <h3 className="distance-head">
              Exposed entry points
              <span className="muted"> · {blast.counts.entryPoints}</span>
            </h3>
            {!blast.entryPoints.length && (
              <div className="muted">
                No externally-reachable entry points found within depth {depth}.
              </div>
            )}
            {blast.entryPoints.length > 0 && (
              <table className="data-table">
                <tbody>
                  {blast.entryPoints.map((n) => (
                    <tr
                      key={n.id}
                      className="row-clickable"
                      onClick={() => navigate(`/graph?focus=${encodeURIComponent(n.id)}`)}
                    >
                      <td>{n.name}</td>
                      <td><LabelBadge label={n.label} /></td>
                      <td><StackBadge stack={n.stack} /></td>
                      <td className="mono muted">
                        {n.distance} hop{n.distance > 1 ? 's' : ''}
                      </td>
                      <td className="mono muted">{n.filePath || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <div className="impact-graph">
            <GraphCanvas
              graph={graph}
              highlightIds={blastSeedIds}
              selectedId={blastSeedIds[0]}
              onNodeClick={() => {}}
              onNodeDblClick={(d) => navigate(`/graph?focus=${encodeURIComponent(d.id)}`)}
              emptyMessage="Nothing depends on the selected class within this depth."
            />
          </div>

          <DistanceTables nodes={nodes} seedIds={blastSeedIds} navigate={navigate} />
        </>
      )}
    </div>
  );
}
