import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useApp } from '../context/AppContext';
import { LabelBadge } from '../components/Badges';
import ProjectSelect from '../components/ProjectSelect';

const COVER_ORDER = ['Route', 'Component', 'ApiCall', 'Endpoint', 'Entity', 'Table'];

export default function ScenariosPage() {
  const { project, pushToast } = useApp();
  const [scenarios, setScenarios] = useState([]);
  const [loading, setLoading] = useState(false);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    setError(null);
    try {
      const list = await api.scenarios({ project });
      setScenarios(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(err.message);
      setScenarios([]);
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    load();
    return () => clearInterval(pollRef.current);
  }, [load]);

  const build = async () => {
    if (!project) return;
    setBuilding(true);
    try {
      const { jobId } = await api.buildScenarios(project);
      pollRef.current = setInterval(async () => {
        try {
          const job = await api.job(jobId);
          if (job.status === 'done' || job.status === 'error') {
            clearInterval(pollRef.current);
            setBuilding(false);
            if (job.status === 'error') pushToast(`Scenario build failed: ${job.error}`);
            else pushToast('Scenarios built', 'success');
            load();
          }
        } catch {
          clearInterval(pollRef.current);
          setBuilding(false);
        }
      }, 1500);
    } catch (err) {
      setBuilding(false);
      pushToast(err.message);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Scenarios — the “+1” view</h2>
          <p className="muted">
            Use-case slices derived from each route: screen → components → API calls →
            endpoints → entities → tables, named by the LLM.
          </p>
        </div>
        <div className="page-head-actions">
          <ProjectSelect />
          <button className="btn" onClick={build} disabled={building || !project}>
            {building ? 'Building…' : scenarios.length ? 'Rebuild scenarios' : 'Build scenarios'}
          </button>
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}
      {loading && <div className="muted">Loading…</div>}
      {!loading && !error && scenarios.length === 0 && (
        <div className="empty-state">
          No scenarios yet — ingest a project, then click “Build scenarios”.
        </div>
      )}

      <div className="scenario-grid">
        {scenarios.map((s) => (
          <div key={s.id} className="card scenario-card">
            <div className="scenario-head">
              <h3>{s.title}</h3>
              <span className="mono small muted">/{s.routePath}</span>
            </div>
            {s.summary && <p className="scenario-summary">{s.summary}</p>}
            <div className="scenario-covers">
              {COVER_ORDER.filter((l) => s.covers?.[l]?.length).map((label) => (
                <div key={label} className="scenario-cover-row">
                  <LabelBadge label={label} />
                  <div className="scenario-cover-items">
                    {s.covers[label].map((n) => (
                      <Link
                        key={n.id}
                        className="chip chip-link mono"
                        to={`/graph?focus=${encodeURIComponent(n.id)}`}
                        title={n.id}
                      >
                        {n.name}
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
