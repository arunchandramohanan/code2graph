import { useApp } from '../context/AppContext';

export default function Toasts() {
  const { toasts, removeToast } = useApp();
  if (!toasts.length) return null;
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`} onClick={() => removeToast(t.id)}>
          <span className="toast-dot" />
          <span className="toast-msg">{t.message}</span>
          <button className="toast-close" aria-label="dismiss">×</button>
        </div>
      ))}
    </div>
  );
}
