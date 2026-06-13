import { useEffect, useRef } from 'react';
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
    selector: 'node:selected',
    style: { 'border-width': 3, 'border-color': '#f8fafc' },
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
      label: 'data(type)',
      'font-size': 7,
      color: '#5b6b80',
      'text-rotation': 'autorotate',
      'text-background-color': '#0b0f17',
      'text-background-opacity': 0.75,
      'text-background-padding': 1,
    },
  },
  {
    selector: 'edge[type = "INVOKES_API"]',
    style: {
      'line-style': 'dashed',
      width: 2.6,
      'line-color': '#ec4899',
      'target-arrow-color': '#ec4899',
      color: '#ec4899',
    },
  },
];

export default function GraphCanvas({ graph, onNodeClick, onNodeDblClick, selectedId, emptyMessage }) {
  const containerRef = useRef(null);
  const cyRef = useRef(null);
  const clickRef = useRef(null);
  const dblRef = useRef(null);
  const lastTapRef = useRef({ id: null, time: 0 });
  clickRef.current = onNodeClick;
  dblRef.current = onNodeDblClick;

  useEffect(() => {
    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      style: STYLE,
      wheelSensitivity: 0.25,
      minZoom: 0.05,
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

    if (nodes.length) {
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
      cy.fit(undefined, 40);
    }
  }, [graph]);

  // Reflect external selection.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes(':selected').unselect();
    if (selectedId) {
      const el = cy.getElementById(selectedId);
      if (el && el.length) el.select();
    }
  }, [selectedId, graph]);

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
    if (cy) cy.fit(undefined, 40);
  };

  const isEmpty = !graph || !graph.nodes || graph.nodes.length === 0;

  return (
    <div className="graph-wrap">
      <div ref={containerRef} className="graph-canvas" />
      {isEmpty && (
        <div className="graph-empty">{emptyMessage || 'No graph data'}</div>
      )}
      <div className="graph-controls">
        <button className="btn btn-icon" onClick={() => zoom(1.3)} title="Zoom in">+</button>
        <button className="btn btn-icon" onClick={() => zoom(1 / 1.3)} title="Zoom out">−</button>
        <button className="btn btn-icon" onClick={fit} title="Fit graph">⤢</button>
      </div>
    </div>
  );
}
