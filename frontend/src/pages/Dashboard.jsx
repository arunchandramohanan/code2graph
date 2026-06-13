import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useApp } from '../context/AppContext';
import { colorFor } from '../constants';
import ConfirmDialog from '../components/ConfirmDialog';

function HealthIndicator() {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .health()
        .then((h) => {
          if (!cancelled) {
            setHealth(h);
            setError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setHealth(null);
            setError(err.message);
          }
        });
    load();
    const t = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const dot = (ok) => (
    <span className={`status-dot ${ok ? 'dot-ok' : 'dot-bad'}`} />
  );

  return (
    <div className="health-bar">
      {error ? (
        <>
          {dot(false)} <span className="muted">backend offline — {error}</span>
        </>
      ) : health ? (
        <>
          <span className="health-item">{dot(health.neo4j)} neo4j</span>
          <span className="health-item">{dot(health.llm)} llm</span>
          <span className="health-item muted">status: {health.status}</span>
        </>
      ) : (
        <span className="muted">checking backend…</span>
      )}
    </div>
  );
}

function JobProgress({ job }) {
  if (!job) return null;
  const steps = job.steps || [];
  return (
    <div className="job-panel">
      <div className="job-header">
        Job <span className="mono">{job.jobId}</span>
        <span className={`job-status job-${job.status}`}>{job.status}</span>
      </div>
      <ul className="job-steps">
        {steps.map((s, i) => (
          <li key={i} className={`job-step step-${s.status}`}>
            <span className="step-icon">
              {s.status === 'done' ? '✓' : s.status === 'error' ? '✗' : s.status === 'running' ? '◌' : '·'}
            </span>
            <span className="step-name">{s.name}</span>
            {s.detail ? <span className="step-detail muted">{s.detail}</span> : null}
          </li>
        ))}
      </ul>
      {job.stats ? (
        <pre className="job-stats mono">{JSON.stringify(job.stats, null, 2)}</pre>
      ) : null}
    </div>
  );
}

export default function Dashboard() {
  const { projects, projectsError, refreshProjects, pushToast, setProject } = useApp();
  const [form, setForm] = useState({ project: '', javaPath: '', angularPath: '' });
  const [mode, setMode] = useState('github');
  const [gh, setGh] = useState({ repoUrl: '', ref: '', project: '' });
  const [precheck, setPrecheck] = useState(null);
  const [checking, setChecking] = useState(false);
  const [job, setJob] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [toDelete, setToDelete] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => () => clearInterval(pollRef.current), []);

  const startPolling = (jobId) => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const j = await api.job(jobId);
        setJob(j);
        if (j.status === 'done' || j.status === 'error') {
          clearInterval(pollRef.current);
          refreshProjects();
          if (j.status === 'error') pushToast('Ingestion failed — check job steps.');
          else pushToast('Ingestion complete.', 'success');
        }
      } catch (err) {
        clearInterval(pollRef.current);
        setJob((prev) => (prev ? { ...prev, status: 'error' } : prev));
        pushToast(`Job polling failed: ${err.message}`);
      }
    }, 1500);
  };

  const onIngest = async (e) => {
    e.preventDefault();
    if (!form.project.trim()) {
      pushToast('Project name is required.');
      return;
    }
    if (!form.javaPath.trim() && !form.angularPath.trim()) {
      pushToast('Provide at least one of java path / angular path.');
      return;
    }
    setSubmitting(true);
    try {
      const body = { project: form.project.trim(), link: true };
      if (form.javaPath.trim()) body.javaPath = form.javaPath.trim();
      if (form.angularPath.trim()) body.angularPath = form.angularPath.trim();
      const res = await api.ingest(body);
      setJob({ jobId: res.jobId, status: 'queued', steps: [] });
      startPolling(res.jobId);
    } catch (err) {
      pushToast(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const onGithubIngest = async (e) => {
    e.preventDefault();
    const repoUrl = gh.repoUrl.trim();
    if (!repoUrl) {
      pushToast('Repository URL is required.');
      return;
    }
    setSubmitting(true);
    setChecking(true);
    setPrecheck(null);
    setJob(null);
    try {
      const pre = await api.githubPrecheck(repoUrl);
      setPrecheck(pre);
      setChecking(false);
      if (!pre.ok) {
        pushToast(`Pre-check failed: ${pre.detail || 'repository unreachable'}`);
        return;
      }
      if (!pre.neo4j) {
        pushToast('Neo4j is not reachable — cannot ingest.');
        return;
      }
      const body = { repoUrl };
      if (gh.ref.trim()) body.ref = gh.ref.trim();
      if (gh.project.trim()) body.project = gh.project.trim();
      const res = await api.githubIngest(body);
      setJob({ jobId: res.jobId, status: 'queued', steps: [] });
      if (res.project) setProject(res.project);
      startPolling(res.jobId);
    } catch (err) {
      pushToast(err.message);
    } finally {
      setChecking(false);
      setSubmitting(false);
    }
  };

  const onDelete = async () => {
    const name = toDelete;
    setToDelete(null);
    try {
      await api.deleteProject(name);
      pushToast(`Project "${name}" deleted.`, 'success');
      refreshProjects();
    } catch (err) {
      pushToast(err.message);
    }
  };

  const fmtDate = (iso) => {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Dashboard</h1>
        <HealthIndicator />
      </div>

      <section className="section">
        <h2>Projects</h2>
        {projectsError && (
          <div className="error-box">
            Could not load projects: {projectsError}
            <button className="btn btn-small" onClick={refreshProjects}>Retry</button>
          </div>
        )}
        {!projectsError && projects.length === 0 && (
          <div className="empty-box">No projects ingested yet. Use the form below to ingest one.</div>
        )}
        <div className="card-grid">
          {projects.map((p) => {
            const edgeTotal = Object.values(p.edgeCounts || {}).reduce((a, b) => a + b, 0);
            return (
              <div key={p.name} className="card project-card">
                <div className="card-head">
                  <span className="card-title mono">{p.name}</span>
                  <button
                    className="btn btn-small btn-danger"
                    onClick={() => setToDelete(p.name)}
                  >
                    Delete
                  </button>
                </div>
                <div className="chip-row">
                  {Object.entries(p.nodeCounts || {})
                    .sort((a, b) => b[1] - a[1])
                    .map(([label, n]) => (
                      <span
                        key={label}
                        className="chip"
                        style={{ borderColor: colorFor(label), color: colorFor(label) }}
                      >
                        {label} {n}
                      </span>
                    ))}
                </div>
                <div className="card-meta">
                  <span>{edgeTotal} edges</span>
                  <span className="muted">ingested {fmtDate(p.lastIngestedAt)}</span>
                </div>
                <div className="card-actions">
                  <button
                    className="btn btn-small"
                    onClick={() => setProject(p.name)}
                  >
                    Set active
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="section">
        <h2>Ingest a project</h2>
        <div className="tab-row">
          <button
            className={`tab ${mode === 'github' ? 'tab-active' : ''}`}
            onClick={() => setMode('github')}
            type="button"
          >
            GitHub repository
          </button>
          <button
            className={`tab ${mode === 'local' ? 'tab-active' : ''}`}
            onClick={() => setMode('local')}
            type="button"
          >
            Local paths
          </button>
        </div>

        {mode === 'github' && (
          <form className="ingest-form" onSubmit={onGithubIngest}>
            <div className="form-row">
              <label className="field field-wide">
                <span className="field-label">Repository URL</span>
                <input
                  className="input mono"
                  value={gh.repoUrl}
                  onChange={(e) => setGh({ ...gh, repoUrl: e.target.value })}
                  placeholder="https://github.com/owner/repo"
                />
              </label>
              <label className="field field-narrow">
                <span className="field-label">Branch (optional)</span>
                <input
                  className="input mono"
                  value={gh.ref}
                  onChange={(e) => setGh({ ...gh, ref: e.target.value })}
                  placeholder="default"
                />
              </label>
              <label className="field field-narrow">
                <span className="field-label">Project name (optional)</span>
                <input
                  className="input"
                  value={gh.project}
                  onChange={(e) => setGh({ ...gh, project: e.target.value })}
                  placeholder="from repo name"
                />
              </label>
              <button className="btn btn-primary" type="submit" disabled={submitting}>
                {checking ? 'Checking…' : submitting ? 'Starting…' : 'Check & ingest'}
              </button>
            </div>
            <div className="muted small">
              Pre-checks: URL shape, repository reachability, default branch, Neo4j and
              extractor availability — then a shallow clone, automatic Spring Boot/Angular
              detection, and the full 4+1 pipeline (extract, link, physical view, scenarios).
            </div>
            {precheck && (
              <div className={`precheck-box ${precheck.ok ? 'ok' : 'fail'}`}>
                {precheck.ok ? (
                  <>
                    <span>✓ reachable</span>
                    <span>default branch: <b>{precheck.defaultBranch}</b></span>
                    <span>{precheck.branches} branches</span>
                    <span>neo4j: {precheck.neo4j ? '✓' : '✗'}</span>
                    <span>
                      extractors: java {precheck.extractorsReady?.java ? '✓' : '✗'} · angular{' '}
                      {precheck.extractorsReady?.angular ? '✓' : '✗'}
                    </span>
                  </>
                ) : (
                  <span>✗ {precheck.stage}: {precheck.detail}</span>
                )}
              </div>
            )}
          </form>
        )}

        {mode === 'local' && (
        <form className="ingest-form" onSubmit={onIngest}>
          <div className="form-row">
            <label className="field">
              <span className="field-label">Project name</span>
              <input
                className="input"
                value={form.project}
                onChange={(e) => setForm({ ...form, project: e.target.value })}
                placeholder="my-shop"
              />
            </label>
            <label className="field">
              <span className="field-label">Java project path</span>
              <input
                className="input mono"
                value={form.javaPath}
                onChange={(e) => setForm({ ...form, javaPath: e.target.value })}
                placeholder="/abs/path/to/spring-app"
              />
            </label>
            <label className="field">
              <span className="field-label">Angular project path</span>
              <input
                className="input mono"
                value={form.angularPath}
                onChange={(e) => setForm({ ...form, angularPath: e.target.value })}
                placeholder="/abs/path/to/angular-app"
              />
            </label>
            <button className="btn btn-primary" type="submit" disabled={submitting}>
              {submitting ? 'Starting…' : 'Ingest'}
            </button>
          </div>
        </form>
        )}
        <JobProgress job={job} />
      </section>

      <ConfirmDialog
        open={!!toDelete}
        title="Delete project"
        message={`Delete project "${toDelete}" and its entire subgraph? This cannot be undone.`}
        onConfirm={onDelete}
        onCancel={() => setToDelete(null)}
      />
    </div>
  );
}
