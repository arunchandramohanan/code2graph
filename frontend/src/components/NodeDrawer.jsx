import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { LabelBadge, StackBadge } from './Badges';

const CORE_KEYS = new Set(['id', 'name', 'label', 'stack', 'fqn', 'project', 'filePath', 'startLine', 'endLine', 'hash']);

function PropValue({ value }) {
  if (Array.isArray(value)) {
    if (!value.length) return <span className="muted">[]</span>;
    return (
      <ul className="prop-list">
        {value.map((v, i) => (
          <li key={i} className="mono">{String(v)}</li>
        ))}
      </ul>
    );
  }
  if (value === null || value === undefined || value === '') return <span className="muted">—</span>;
  return <span className="mono">{String(value)}</span>;
}

export default function NodeDrawer({ nodeId, onClose, onExpand, onFocusNode }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!nodeId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    api
      .node(nodeId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  if (!nodeId) return null;

  const node = data && data.node;
  const neighbors = (data && data.neighbors) || [];
  const grouped = {};
  neighbors.forEach((n) => {
    const key = `${n.direction === 'in' || n.direction === 'incoming' ? '← ' : '→ '}${n.relType}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(n);
  });

  const extraProps = node
    ? Object.entries(node).filter(([k]) => !CORE_KEYS.has(k))
    : [];

  return (
    <aside className="drawer">
      <div className="drawer-header">
        <div className="drawer-title">
          {node ? node.name : 'Node details'}
        </div>
        <button className="btn btn-icon" onClick={onClose} title="Close">×</button>
      </div>
      <div className="drawer-body">
        {loading && <div className="loading">Loading node…</div>}
        {error && <div className="error-box">{error}</div>}
        {node && (
          <>
            <div className="drawer-badges">
              <LabelBadge label={node.label} />
              <StackBadge stack={node.stack} />
            </div>
            <div className="drawer-fqn mono">{node.fqn}</div>
            {node.filePath ? (
              <div className="drawer-file mono">
                {node.filePath}
                {node.startLine ? `:${node.startLine}` : ''}
              </div>
            ) : null}

            <div className="drawer-actions">
              <button className="btn btn-primary" onClick={() => onExpand && onExpand(node.id)}>
                Expand into graph
              </button>
              <button
                className="btn"
                onClick={() =>
                  navigate(`/impact?node=${encodeURIComponent(node.id)}`, {
                    state: { nodeName: node.name, nodeLabel: node.label },
                  })
                }
              >
                Impact analysis
              </button>
            </div>

            <h4 className="drawer-section">Properties</h4>
            <table className="prop-table">
              <tbody>
                <tr><td>project</td><td><PropValue value={node.project} /></td></tr>
                <tr><td>id</td><td><PropValue value={node.id} /></td></tr>
                {node.startLine ? (
                  <tr><td>lines</td><td><span className="mono">{node.startLine}–{node.endLine}</span></td></tr>
                ) : null}
                {extraProps.map(([k, v]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td><PropValue value={v} /></td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h4 className="drawer-section">Neighbors ({neighbors.length})</h4>
            {!neighbors.length && <div className="muted">No connected nodes.</div>}
            {Object.entries(grouped).map(([rel, list]) => (
              <div key={rel} className="neighbor-group">
                <div className="neighbor-rel mono">{rel}</div>
                {list.map((n, i) => (
                  <button
                    key={(n.node && n.node.id) || i}
                    className="neighbor-row"
                    onClick={() => n.node && onFocusNode && onFocusNode(n.node.id)}
                    title={n.node ? n.node.fqn : ''}
                  >
                    <LabelBadge label={n.node ? n.node.label : '?'} />
                    <span className="neighbor-name">{n.node ? n.node.name : '(unknown)'}</span>
                  </button>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </aside>
  );
}
