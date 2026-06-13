import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useApp } from '../context/AppContext';
import { NODE_LABELS, EDGE_TYPES, VIEWS } from '../constants';
import GraphCanvas from '../components/GraphCanvas';
import Legend from '../components/Legend';
import NodeDrawer from '../components/NodeDrawer';
import ProjectSelect from '../components/ProjectSelect';

const edgeKey = (e) => e.id || `${e.source}|${e.type}|${e.target}`;

function mergeGraphs(base, inc) {
  const nodeMap = new Map((base.nodes || []).map((n) => [n.id, n]));
  (inc.nodes || []).forEach((n) => {
    if (n && n.id) nodeMap.set(n.id, { ...(nodeMap.get(n.id) || {}), ...n });
  });
  const edgeMap = new Map((base.edges || []).map((e) => [edgeKey(e), e]));
  (inc.edges || []).forEach((e) => {
    if (e && e.source && e.target) edgeMap.set(edgeKey(e), e);
  });
  return { nodes: [...nodeMap.values()], edges: [...edgeMap.values()] };
}

function CheckboxGroup({ title, options, selected, onChange }) {
  const allSelected = selected.size === options.length;
  return (
    <div className="filter-group">
      <div className="filter-group-head">
        <span className="filter-group-title">{title}</span>
        <button
          className="btn btn-tiny"
          onClick={() => onChange(allSelected ? new Set() : new Set(options))}
        >
          {allSelected ? 'none' : 'all'}
        </button>
      </div>
      <div className="checkbox-list">
        {options.map((opt) => (
          <label key={opt} className="checkbox-row">
            <input
              type="checkbox"
              checked={selected.has(opt)}
              onChange={() => {
                const next = new Set(selected);
                if (next.has(opt)) next.delete(opt);
                else next.add(opt);
                onChange(next);
              }}
            />
            <span>{opt}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export default function GraphExplorer() {
  const { project, pushToast } = useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const focus = searchParams.get('focus') || '';

  const [view, setView] = useState('logical');
  const [labels, setLabels] = useState(() => new Set(NODE_LABELS));
  const [edgeTypes, setEdgeTypes] = useState(() => new Set(EDGE_TYPES));
  const [depth, setDepth] = useState(2);
  const [graph, setGraph] = useState({ nodes: [], edges: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(focus || null);

  const labelsParam = labels.size === NODE_LABELS.length ? '' : [...labels].join(',');
  const edgeTypesParam = edgeTypes.size === EDGE_TYPES.length ? '' : [...edgeTypes].join(',');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = { limit: 300 };
      if (project) params.project = project;
      if (focus) {
        params.nodeId = focus;
        params.depth = depth;
        if (labelsParam) params.labels = labelsParam;
        if (edgeTypesParam) params.edgeTypes = edgeTypesParam;
      } else if (view) {
        params.view = view;
      } else {
        if (labelsParam) params.labels = labelsParam;
        if (edgeTypesParam) params.edgeTypes = edgeTypesParam;
      }
      const g = await api.subgraph(params);
      setGraph({ nodes: (g && g.nodes) || [], edges: (g && g.edges) || [] });
      if (focus) setSelectedId(focus);
    } catch (err) {
      setError(err.message);
      setGraph({ nodes: [], edges: [] });
    } finally {
      setLoading(false);
    }
  }, [project, labelsParam, edgeTypesParam, depth, focus, view]);

  useEffect(() => {
    load();
  }, [load]);

  const expandNode = useCallback(
    async (nodeId) => {
      try {
        const params = { nodeId, depth: 1, limit: 200 };
        if (project) params.project = project;
        const g = await api.subgraph(params);
        setGraph((prev) => mergeGraphs(prev, g || {}));
      } catch (err) {
        pushToast(`Expand failed: ${err.message}`);
      }
    },
    [project, pushToast]
  );

  const visibleLabels = useMemo(() => {
    const set = new Set((graph.nodes || []).map((n) => n.label).filter(Boolean));
    return [...set];
  }, [graph]);

  return (
    <div className="page page-fill">
      <div className="explorer-layout">
        <aside className="filter-panel">
          <h2>Graph Explorer</h2>
          <div className="filter-group">
            <span className="filter-group-title">Project</span>
            <ProjectSelect />
          </div>
          <div className="filter-group">
            <span className="filter-group-title">Architectural view (4+1)</span>
            <select
              className="select"
              value={view}
              onChange={(e) => setView(e.target.value)}
            >
              {VIEWS.map((v) => (
                <option key={v.key} value={v.key}>{v.name}</option>
              ))}
            </select>
            {view && <div className="muted small">Preset filters; switch to Custom to use the checkboxes</div>}
          </div>
          <div className="filter-group">
            <div className="filter-group-head">
              <span className="filter-group-title">Depth: {depth}</span>
            </div>
            <input
              type="range"
              min="1"
              max="4"
              value={depth}
              onChange={(e) => setDepth(Number(e.target.value))}
            />
            <div className="muted small">Applies when focused on a node</div>
          </div>
          {focus && (
            <div className="focus-banner">
              <div className="muted small">Focused node</div>
              <div className="mono small ellipsis" title={focus}>{focus}</div>
              <button
                className="btn btn-tiny"
                onClick={() => {
                  setSearchParams({});
                  setSelectedId(null);
                }}
              >
                Clear focus
              </button>
            </div>
          )}
          {(!view || focus) && (
            <>
              <CheckboxGroup
                title="Node labels"
                options={NODE_LABELS}
                selected={labels}
                onChange={setLabels}
              />
              <CheckboxGroup
                title="Edge types"
                options={EDGE_TYPES}
                selected={edgeTypes}
                onChange={setEdgeTypes}
              />
            </>
          )}
          <Legend labels={visibleLabels} />
        </aside>

        <div className="explorer-canvas">
          {loading && <div className="canvas-overlay loading">Loading graph…</div>}
          {error && (
            <div className="canvas-overlay">
              <div className="error-box">
                {error}
                <button className="btn btn-small" onClick={load}>Retry</button>
              </div>
            </div>
          )}
          <GraphCanvas
            graph={graph}
            selectedId={selectedId}
            onNodeClick={(d) => setSelectedId(d.id)}
            onNodeDblClick={(d) => expandNode(d.id)}
            emptyMessage={
              loading
                ? ''
                : 'No nodes to display — pick a project, adjust filters, or ingest data first.'
            }
          />
        </div>

        {selectedId && (
          <NodeDrawer
            nodeId={selectedId}
            onClose={() => setSelectedId(null)}
            onExpand={expandNode}
            onFocusNode={(id) => setSelectedId(id)}
          />
        )}
      </div>
    </div>
  );
}
