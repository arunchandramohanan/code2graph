import { LABEL_COLORS } from '../constants';

export default function Legend({ labels }) {
  const entries = (labels && labels.length ? labels : Object.keys(LABEL_COLORS)).map(
    (l) => [l, LABEL_COLORS[l] || '#6b7280']
  );
  return (
    <div className="legend">
      <div className="legend-title">Legend</div>
      <div className="legend-grid">
        {entries.map(([label, color]) => (
          <div key={label} className="legend-item">
            <span className="legend-swatch" style={{ background: color }} />
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className="legend-notes">
        <div className="legend-item">
          <span className="legend-swatch swatch-square" />
          <span>java (rounded square)</span>
        </div>
        <div className="legend-item">
          <span className="legend-swatch swatch-circle" />
          <span>angular (circle)</span>
        </div>
        <div className="legend-item">
          <span className="legend-swatch swatch-diamond" />
          <span>system / dependency (diamond)</span>
        </div>
        <div className="legend-item">
          <span className="legend-swatch swatch-hexagon" />
          <span>infra (hexagon)</span>
        </div>
        <div className="legend-item">
          <span className="legend-dash" />
          <span>INVOKES_API (cross-stack)</span>
        </div>
      </div>
    </div>
  );
}
