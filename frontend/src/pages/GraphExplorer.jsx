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
  const [dominantOnly, setDominantOnly] = useState(true);
  const [displayOpen, setDisplayOpen] = useState(false);
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

  // "dominantOnly" keeps only the largest connected component (the main graph).
  // Skipped while focused on a node — there the neighborhood is the intent.
  const displayGraph = useMemo(() => {
    let nodes = graph.nodes || [];
    let edges = graph.edges || [];

    if (dominantOnly && !focus && nodes.length > 1) {
      const adj = new Map(nodes.map((n) => [n.id, []]));
      edges.forEach((e) => {
        if (adj.has(e.source) && adj.has(e.target)) {
          adj.get(e.source).push(e.target);
          adj.get(e.target).push(e.source);
        }
      });
      const seen = new Set();
      let best = new Set();
      for (const start of adj.keys()) {
        if (seen.has(start)) continue;
        const comp = new Set([start]);
        const stack = [start];
        seen.add(start);
        while (stack.length) {
          for (const nb of adj.get(stack.pop())) {
            if (!seen.has(nb)) {
              seen.add(nb);
              comp.add(nb);
              stack.push(nb);
            }
          }
        }
        if (comp.size > best.size) best = comp;
      }
      nodes = nodes.filter((n) => best.has(n.id));
      const ids = new Set(nodes.map((n) => n.id));
      edges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    }

    return { nodes, edges };
  }, [graph, dominantOnly, focus]);

  const hiddenCount = (graph.nodes || []).length - (displayGraph.nodes || []).length;

  const visibleLabels = useMemo(() => {
    const set = new Set((displayGraph.nodes || []).map((n) => n.label).filter(Boolean));
    return [...set];
  }, [displayGraph]);

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
          <div className="filter-group display-options">
            <button
              type="button"
              className="disclosure-head"
              onClick={() => setDisplayOpen((o) => !o)}
            >
              <span className="filter-group-title">Display options</span>
              <span className="disclosure-chevron">{displayOpen ? '▾' : '▸'}</span>
            </button>
            {displayOpen && (
              <div className="disclosure-body">
                <div className="filter-subgroup">
                  <span className="filter-group-title">Depth: {depth}</span>
                  <input
                    type="range"
                    min="1"
                    max="4"
                    value={depth}
                    onChange={(e) => setDepth(Number(e.target.value))}
                  />
                  <div className="muted small">Applies when focused on a node</div>
                </div>
                <div className="filter-subgroup">
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={dominantOnly}
                      onChange={(e) => setDominantOnly(e.target.checked)}
                    />
                    <span>Show only the main graph</span>
                  </label>
                  {dominantOnly && !focus && hiddenCount > 0 && (
                    <div className="muted small">
                      {hiddenCount} off-graph node{hiddenCount === 1 ? '' : 's'} hidden
                    </div>
                  )}
                  {focus && dominantOnly && (
                    <div className="muted small">Main-graph filter pauses while focused on a node</div>
                  )}
                </div>
              </div>
            )}
          </div>
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
            graph={displayGraph}
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
