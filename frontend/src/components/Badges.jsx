import { colorFor } from '../constants';

export function LabelBadge({ label }) {
  const color = colorFor(label);
  return (
    <span className="badge" style={{ borderColor: color, color }}>
      <span className="badge-dot" style={{ background: color }} />
      {label}
    </span>
  );
}

export function StackBadge({ stack }) {
  if (!stack) return null;
  return <span className={`stack-badge stack-${stack}`}>{stack}</span>;
}

export function TierBadge({ tier }) {
  return <span className={`tier-badge tier-${tier || 'unknown'}`}>{tier || '?'}</span>;
}

export function MethodBadge({ method }) {
  return <span className={`http-badge http-${(method || '').toLowerCase()}`}>{method || '?'}</span>;
}
