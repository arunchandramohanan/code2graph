import { useEffect, useRef, useState } from 'react';
import cytoscape from 'cytoscape';
import { colorFor } from '../constants';

const STYLE = [
  {
    selector: 'node',
    style: {
      'background-color': 'data(color)',
      shape: 'ellipse',
      width: 30,
      height: 30,
      label: 'data(displayName)',
      color: '#cbd5e1',
      'font-size': 9,
      'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
      'text-valign': 'bottom',
      'text-halign': 'center',
      'text-margin-y': 5,
      'text-wrap': 'ellipsis',
      'text-max-width': 130,
      'border-width': 1,
      'border-color': 'rgba(255,255,255,0.18)',
    },
  },
  {
    selector: 'node[stack = "java"]',
    style: { shape: 'round-rectangle', width: 34, height: 26 },
  },
  {
    selector: 'node[stack = "infra"]',
    style: { shape: 'hexagon' },
  },
  {
    selector: 'node[stack = "system"]',
    style: { shape: 'diamond' },
  },
  {
    selector: 'node:selected',
    style: { 'border-width': 3, 'border-color': '#f8fafc' },
  },
  // Vulnerable "seed" nodes in a blast-radius view: a red ring.
  {
    selector: 'node.seed',
    style: { 'border-width': 4, 'border-color': '#ef4444' },
  },
  // Highlight a hovered node and its neighbours.
  {
    selector: 'node.hl',
    style: { 'border-width': 3, 'border-color': '#38bdf8', color: '#e2f3ff' },
  },
  {
    selector: 'edge',
    style: {
      width: 1.2,
      'line-color': '#3b4759',
      'target-arrow-color': '#3b4759',
      'target-arrow-shape': 'triangle',
      'arrow-scale': 0.8,
      'curve-style': 'bezier',
    },
  },
  // Edge labels are noisy on a big graph — only show them on hover / selection.
  {
    selector: 'edge.show-label',
    style: {
      label: 'data(type)',
      'font-size': 7,
      color: '#9fb0c4',
      'text-rotation': 'autorotate',
      'text-background-color': '#0b0f17',
      'text-background-opacity': 0.8,
      'text-background-padding': 1,
    },
  },
  {
    selector: 'edge.dim',
    style: { opacity: 0.18 },
  },
  {
    selector: 'edge[type = "INVOKES_API"]',
    style: {
      'line-style': 'dashed',
      width: 2.6,
      'line-color': '#ec4899',
      'target-arrow-color': '#ec4899',
      label: 'data(type)',
      color: '#ec4899',
      'font-size': 7,
      'text-rotation': 'autorotate',
      'text-background-color': '#0b0f17',
      'text-background-opacity': 0.8,
    },
  },
  // Highlight: applied to a hovered node's connecting lines. Last in the list so
  // it overrides the default and INVOKES_API colours.
  {
    selector: 'edge.hl',
    style: {
      'line-color': '#38bdf8',
      'target-arrow-color': '#38bdf8',
      color: '#7dd3fc',
      width: 2.8,
      opacity: 1,
      'z-index': 999,
    },
  },
];

// Vertical tier per node: Angular at the top, ApiCall in the middle, backend below.
function tierOf(stack, label) {
  if (stack === 'system') return 0; // Scenario
  if (stack === 'angular') {
    if (label === 'Route') return 0;
    if (label === 'Component') return 1;
    if (label === 'ApiCall') return 3; // the middle band
    return 2; // Angular Service / Class / Module
  }
  if (stack === 'java') {
    if (label === 'Endpoint') return 4;
    if (label === 'Controller') return 5;
    if (label === 'Repository') return 7;
    if (label === 'Entity') return 8;
    if (label === 'Table' || label === 'Topic') return 9;
    return 6; // Service / DTO / Class
  }
  if (stack === 'infra') return 10; // Deployment / Datasource
  return 6;
}

// Layered DAG positions, top→bottom, with a few barycenter sweeps to cut crossings.
function layeredPositions(nodes, edges) {
  const ROW = 150;
  const COL = 95;
  const tierOfId = new Map();
  const tiers = new Map();
  nodes.forEach((n) => {
    const t = tierOf(n.stack, n.label);
    tierOfId.set(n.id, t);
    if (!tiers.has(t)) tiers.set(t, []);
    tiers.get(t).push(n.id);
  });

  const adj = new Map(nodes.map((n) => [n.id, []]));
  edges.forEach((e) => {
    if (adj.has(e.source) && adj.has(e.target)) {
      adj.get(e.source).push(e.target);
      adj.get(e.target).push(e.source);
    }
  });

  const sortedTiers = [...tiers.keys()].sort((a, b) => a - b);
  const order = new Map();
  sortedTiers.forEach((t) => {
    const arr = tiers.get(t).slice().sort();
    tiers.set(t, arr);
    arr.forEach((id, i) => order.set(id, i));
  });

  for (let pass = 0; pass < 4; pass += 1) {
    for (const t of sortedTiers) {
      const arr = tiers.get(t);
      const bary = new Map();
      arr.forEach((id) => {
        const nbrs = adj.get(id).filter((m) => tierOfId.get(m) !== t);
        const v = nbrs.length
          ? nbrs.reduce((s, m) => s + (order.get(m) ?? 0), 0) / nbrs.length
          : (order.get(id) ?? 0);
        bary.set(id, v);
      });
      arr.sort((a, b) => bary.get(a) - bary.get(b) || a.localeCompare(b));
      arr.forEach((id, i) => order.set(id, i));
    }
  }

  const pos = {};
  sortedTiers.forEach((t, rank) => {
    const arr = tiers.get(t);
    const width = (arr.length - 1) * COL;
    arr.forEach((id, i) => {
      pos[id] = { x: i * COL - width / 2, y: rank * ROW };
    });
  });
  return pos;
}

const LAYOUT_CYCLE = { layered: 'force', force: 'tree', tree: 'layered' };
const LAYOUT_ICON = { layered: '⤓', force: '✸', tree: '⌗' };
const LAYOUT_TITLE = {
  layered: 'Layered (top→bottom). Click for force layout',
  force: 'Force layout. Click for tree layout',
  tree: 'Tree / call-depth layout. Click for layered',
};

export default function GraphCanvas({
  graph, onNodeClick, onNodeDblClick, selectedId, emptyMessage, defaultLayout = 'layered',
  highlightIds,
}) {
  const containerRef = useRef(null);
  const wrapRef = useRef(null);
  const cyRef = useRef(null);
  const clickRef = useRef(null);
  const dblRef = useRef(null);
  const lastTapRef = useRef({ id: null, time: 0 });
  const [layoutMode, setLayoutMode] = useState(defaultLayout);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Adopt the per-view preferred layout when it changes (e.g. switching to Call graph).
  useEffect(() => {
    setLayoutMode(defaultLayout);
  }, [defaultLayout]);
  const layoutModeRef = useRef(layoutMode);
  layoutModeRef.current = layoutMode;
  clickRef.current = onNodeClick;
  dblRef.current = onNodeDblClick;

  const applyLayout = (cy, mode) => {
    if (!cy || !cy.nodes().length) return;
    if (mode === 'layered') {
      const nodes = cy.nodes().map((n) => n.data());
      const edges = cy.edges().map((e) => e.data());
      const pos = layeredPositions(nodes, edges);
      cy.layout({
        name: 'preset',
        positions: (n) => pos[n.id()] || { x: 0, y: 0 },
        fit: true,
        padding: 45,
      }).run();
    } else if (mode === 'tree') {
      // call-depth tree: ranks nodes by distance from entry points (no incoming flow edge)
      cy.layout({
        name: 'breadthfirst',
        directed: true,
        grid: true,
        spacingFactor: 1.32,
        padding: 45,
        avoidOverlap: true,
      }).run();
    } else {
      cy.layout({
        name: 'cose',
        animate: false,
        padding: 40,
        nodeOverlap: 12,
        nodeRepulsion: () => 9000,
        idealEdgeLength: () => 90,
        gravity: 40,
        numIter: 800,
      }).run();
    }
    cy.fit(undefined, 45);
  };

  useEffect(() => {
    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      style: STYLE,
      wheelSensitivity: 0.25,
      minZoom: 0.04,
      maxZoom: 5,
    });
    cy.on('tap', 'node', (evt) => {
      const id = evt.target.id();
      const now = Date.now();
      const last = lastTapRef.current;
      const data = evt.target.data();
      if (last.id === id && now - last.time < 380) {
        lastTapRef.current = { id: null, time: 0 };
        if (dblRef.current) dblRef.current(data);
      } else {
        lastTapRef.current = { id, time: now };
        if (clickRef.current) clickRef.current(data);
      }
    });
    // Reveal edge labels on hover without permanently cluttering the graph:
    // hovering a node lights up all its connecting lines, hovering a single line
    // labels just that one. (INVOKES_API lines already carry a permanent label.)
    cy.on('mouseover', 'node', (evt) => {
      evt.target.connectedEdges().addClass('show-label hl');
      evt.target.neighborhood('node').add(evt.target).addClass('hl');
    });
    cy.on('mouseout', 'node', (evt) => {
      evt.target.connectedEdges().removeClass('show-label hl');
      evt.target.neighborhood('node').add(evt.target).removeClass('hl');
    });
    cy.on('mouseover', 'edge', (evt) => evt.target.addClass('show-label'));
    cy.on('mouseout', 'edge', (evt) => evt.target.removeClass('show-label'));
    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  // Rebuild elements + re-run layout whenever the graph data changes.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const rawNodes = (graph && graph.nodes) || [];
    const rawEdges = (graph && graph.edges) || [];
    const nodes = rawNodes
      .filter((n) => n && n.id)
      .map((n) => ({
        data: {
          ...n,
          id: n.id,
          displayName: n.name || n.id,
          color: colorFor(n.label),
        },
      }));
    const ids = new Set(nodes.map((n) => n.data.id));
    const edges = rawEdges
      .filter((e) => e && ids.has(e.source) && ids.has(e.target))
      .map((e, i) => ({
        data: {
          id: e.id || `e${i}:${e.source}->${e.target}:${e.type || ''}`,
          source: e.source,
          target: e.target,
          type: e.type || '',
        },
      }));

    cy.startBatch();
    cy.elements().remove();
    cy.add([...nodes, ...edges]);
    cy.endBatch();

    if (nodes.length) applyLayout(cy, layoutModeRef.current);
  }, [graph]);

  // Re-run layout when the user switches mode.
  useEffect(() => {
    const cy = cyRef.current;
    if (cy) applyLayout(cy, layoutMode);
  }, [layoutMode]);

  // Reflect seed highlighting (vulnerable nodes in a blast-radius view).
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes('.seed').removeClass('seed');
    (highlightIds || []).forEach((id) => {
      const el = cy.getElementById(id);
      if (el && el.length) el.addClass('seed');
    });
  }, [highlightIds, graph]);

  // Reflect external selection.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes(':selected').unselect();
    cy.edges('.show-label').removeClass('show-label');
    if (selectedId) {
      const el = cy.getElementById(selectedId);
      if (el && el.length) {
        el.select();
        el.connectedEdges().addClass('show-label');
      }
    }
  }, [selectedId, graph]);

  // Fullscreen: resize/refit cytoscape whenever we enter or leave fullscreen.
  useEffect(() => {
    const onChange = () => {
      const active = document.fullscreenElement === wrapRef.current;
      setIsFullscreen(active);
      const cy = cyRef.current;
      if (cy) {
        setTimeout(() => {
          cy.resize();
          cy.fit(undefined, 45);
        }, 80);
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (wrapRef.current?.requestFullscreen) {
      wrapRef.current.requestFullscreen();
    }
  };

  const zoom = (factor) => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.zoom({
      level: cy.zoom() * factor,
      renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 },
    });
  };
  const fit = () => {
    const cy = cyRef.current;
    if (cy) cy.fit(undefined, 45);
  };

  const isEmpty = !graph || !graph.nodes || graph.nodes.length === 0;

  return (
    <div className={`graph-wrap${isFullscreen ? ' fullscreen' : ''}`} ref={wrapRef}>
      <div ref={containerRef} className="graph-canvas" />
      {isEmpty && (
        <div className="graph-empty">{emptyMessage || 'No graph data'}</div>
      )}
      <div className="graph-controls">
        <button
          className="btn btn-icon graph-layout-toggle"
          onClick={() => setLayoutMode((m) => LAYOUT_CYCLE[m] || 'layered')}
          title={LAYOUT_TITLE[layoutMode]}
        >
          {LAYOUT_ICON[layoutMode] || '⤓'}
        </button>
        <button className="btn btn-icon" onClick={() => zoom(1.3)} title="Zoom in">+</button>
        <button className="btn btn-icon" onClick={() => zoom(1 / 1.3)} title="Zoom out">−</button>
        <button className="btn btn-icon" onClick={fit} title="Fit graph">⤢</button>
        <button
          className="btn btn-icon"
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit full screen (Esc)' : 'Full screen'}
        >
          {isFullscreen ? '✕' : '⛶'}
        </button>
      </div>
    </div>
  );
}
