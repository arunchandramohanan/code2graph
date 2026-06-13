import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../context/AppContext';
import { MethodBadge, TierBadge } from '../components/Badges';
import ProjectSelect from '../components/ProjectSelect';

function ConfidenceBar({ value }) {
  const v = Math.max(0, Math.min(1, Number(value) || 0));
  const color = v >= 0.9 ? 'var(--green)' : v >= 0.6 ? 'var(--yellow)' : 'var(--red)';
  return (
    <div className="conf-cell" title={v.toFixed(2)}>
      <div className="conf-bar">
        <div className="conf-fill" style={{ width: `${v * 100}%`, background: color }} />
      </div>
      <span className="mono small">{v.toFixed(2)}</span>
    </div>
  );
}

function controllerOf(endpoint) {
  if (!endpoint) return '';
  const fqn = endpoint.fqn || '';
  const hash = fqn.indexOf('#');
  if (hash > 0) {
    const cls = fqn.slice(0, hash);
    return cls.split('.').pop();
  }
  return '';
}

export default function LinksPage() {
  const { project, pushToast } = useApp();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [minConfidence, setMinConfidence] = useState(0);
  const [relinking, setRelinking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = {};
      if (project) params.project = project;
      const res = await api.links(params);
      setData(res);
    } catch (err) {
      setError(err.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    load();
  }, [load]);

  const relink = async () => {
    setRelinking(true);
    try {
      const stats = await api.relink(project || undefined);
      pushToast(
        `Linker finished${stats ? ': ' + JSON.stringify(stats) : ''}`,
        'success'
      );
      load();
    } catch (err) {
      pushToast(err.message);
    } finally {
      setRelinking(false);
    }
  };

  // The API may return a plain array of links, or an object that also
  // carries unmatched ApiCalls / Endpoints. Handle both shapes.
  const links = Array.isArray(data) ? data : (data && (data.links || data.matches)) || [];
  const unmatchedApiCalls =
    (!Array.isArray(data) && data && (data.unmatchedApiCalls || data.unlinkedApiCalls)) || [];
  const unmatchedEndpoints =
    (!Array.isArray(data) && data && (data.unmatchedEndpoints || data.unlinkedEndpoints)) || [];

  const visible = links.filter((l) => (Number(l.confidence) || 0) >= minConfidence);

  return (
    <div className="page">
      <div className="page-header">
        <h1>API Links</h1>
        <div className="header-actions">
          <ProjectSelect />
          <button className="btn btn-primary" onClick={relink} disabled={relinking}>
            {relinking ? 'Relinking…' : 'Re-run linker'}
          </button>
        </div>
      </div>

      <div className="links-toolbar">
        <label className="field field-inline">
          <span className="field-label">Min confidence: {minConfidence.toFixed(2)}</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={minConfidence}
            onChange={(e) => setMinConfidence(Number(e.target.value))}
          />
        </label>
        <span className="muted">
          {visible.length} / {links.length} links shown
        </span>
      </div>

      {loading && <div className="loading">Loading links…</div>}
      {error && (
        <div className="error-box">
          {error}
          <button className="btn btn-small" onClick={load}>Retry</button>
        </div>
      )}
      {!loading && !error && links.length === 0 && (
        <div className="empty-box">
          No cross-stack links found{project ? ` for project "${project}"` : ''}. Try re-running the linker.
        </div>
      )}

      {visible.length > 0 && (
        <table className="data-table links-table">
          <thead>
            <tr>
              <th colSpan="3">Angular — ApiCall</th>
              <th></th>
              <th colSpan="2">Spring — Endpoint</th>
              <th>Confidence</th>
              <th>Tier</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((l, i) => {
              const a = l.apiCall || {};
              const e = l.endpoint || {};
              return (
                <tr key={(a.id || i) + '|' + (e.id || '')}>
                  <td>
                    <MethodBadge method={a.httpMethod} />{' '}
                    <span className="mono">{a.normalizedPath || a.resolvedPath || a.urlExpression || '?'}</span>
                  </td>
                  <td className="mono muted ellipsis" style={{ maxWidth: 240 }} title={a.inMethod}>
                    {a.inMethod || '—'}
                  </td>
                  <td className="mono muted ellipsis" style={{ maxWidth: 200 }} title={a.filePath}>
                    {a.filePath ? `${a.filePath}${a.startLine ? `:${a.startLine}` : ''}` : '—'}
                  </td>
                  <td className="link-arrow">⇢</td>
                  <td>
                    <MethodBadge method={e.httpMethod} />{' '}
                    <span className="mono">{e.path || e.normalizedPath || '?'}</span>
                  </td>
                  <td className="mono muted">{controllerOf(e) || '—'}</td>
                  <td><ConfidenceBar value={l.confidence} /></td>
                  <td><TierBadge tier={l.tier} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {(unmatchedApiCalls.length > 0 || unmatchedEndpoints.length > 0) && (
        <section className="section">
          <h2>Unmatched</h2>
          <div className="unmatched-grid">
            {unmatchedApiCalls.length > 0 && (
              <div>
                <h3>ApiCalls without endpoint ({unmatchedApiCalls.length})</h3>
                <table className="data-table">
                  <tbody>
                    {unmatchedApiCalls.map((a, i) => (
                      <tr key={a.id || i}>
                        <td><MethodBadge method={a.httpMethod} /></td>
                        <td className="mono">{a.normalizedPath || a.resolvedPath || a.urlExpression || '?'}</td>
                        <td className="mono muted">{a.filePath || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {unmatchedEndpoints.length > 0 && (
              <div>
                <h3>Endpoints without caller ({unmatchedEndpoints.length})</h3>
                <table className="data-table">
                  <tbody>
                    {unmatchedEndpoints.map((e, i) => (
                      <tr key={e.id || i}>
                        <td><MethodBadge method={e.httpMethod} /></td>
                        <td className="mono">{e.path || e.normalizedPath || '?'}</td>
                        <td className="mono muted">{controllerOf(e)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
