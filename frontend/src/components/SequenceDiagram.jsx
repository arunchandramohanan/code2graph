import { colorFor } from '../constants';

const COL_W = 190;
const BOX_W = 158;
const HEADER_H = 56;
const ROW_H = 34;
const TOP_PAD = 24;

// Renders an ordered call trace as a UML-style sequence diagram (plain SVG).
export default function SequenceDiagram({ data }) {
  const { participants, steps } = data || {};
  if (!participants || !participants.length) return null;
  const idx = new Map(participants.map((p, i) => [p.name, i]));
  const cx = (name) => COL_W / 2 + (idx.get(name) ?? 0) * COL_W;
  const width = COL_W * participants.length;
  const height = HEADER_H + TOP_PAD + steps.length * ROW_H + 40;
  const lifelineBottom = height - 20;

  return (
    <svg className="seq-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <defs>
        <marker id="seq-arrow" markerWidth="9" markerHeight="9" refX="7" refY="3"
                orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L7,3 L0,6 Z" fill="#7f8ea3" />
        </marker>
      </defs>

      {participants.map((p) => {
        const x = cx(p.name);
        return (
          <g key={p.name}>
            <line x1={x} y1={HEADER_H} x2={x} y2={lifelineBottom}
                  stroke="#2b3442" strokeWidth="1" strokeDasharray="4 4" />
            <rect x={x - BOX_W / 2} y={10} width={BOX_W} height={HEADER_H - 18} rx="6"
                  fill="#141a24" stroke={colorFor(p.label)} strokeWidth="1.5" />
            <circle cx={x - BOX_W / 2 + 12} cy={10 + (HEADER_H - 18) / 2} r="4" fill={colorFor(p.label)} />
            <text x={x + 6} y={10 + (HEADER_H - 18) / 2 + 4} textAnchor="middle"
                  fill="#e5e7eb" fontSize="11" fontFamily="ui-monospace, monospace">
              {p.name.length > 20 ? `${p.name.slice(0, 19)}…` : p.name}
            </text>
          </g>
        );
      })}

      {steps.map((s, i) => {
        const y = HEADER_H + TOP_PAD + i * ROW_H;
        const xf = cx(s.from);
        const xt = cx(s.to);
        const msg = s.message.length > 26 ? `${s.message.slice(0, 25)}…` : s.message;
        if (s.selfCall || xf === xt) {
          return (
            <g key={i}>
              <path d={`M${xf},${y} h26 v14 h-26`} fill="none" stroke="#7f8ea3"
                    strokeWidth="1.2" markerEnd="url(#seq-arrow)" />
              <text x={xf + 32} y={y + 4} fill="#9fb0c4" fontSize="9.5"
                    fontFamily="ui-monospace, monospace">{msg}()</text>
            </g>
          );
        }
        const dir = xt > xf ? 1 : -1;
        const midX = (xf + xt) / 2;
        return (
          <g key={i}>
            <line x1={xf + dir * 2} y1={y} x2={xt - dir * 6} y2={y}
                  stroke="#7f8ea3" strokeWidth="1.2" markerEnd="url(#seq-arrow)" />
            <text x={midX} y={y - 5} textAnchor="middle" fill="#9fb0c4" fontSize="9.5"
                  fontFamily="ui-monospace, monospace">{msg}()</text>
          </g>
        );
      })}
    </svg>
  );
}
