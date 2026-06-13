function qs(params = {}) {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    sp.set(k, v);
  });
  const s = sp.toString();
  return s ? `?${s}` : '';
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch (err) {
    throw new Error('Backend unreachable — is the API running on :3015?');
  }
  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body && body.detail) {
        detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
      }
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  if (res.status === 204) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export const api = {
  health: () => request('/api/health'),
  projects: () => request('/api/projects'),
  deleteProject: (name) =>
    request(`/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  ingest: (body) => request('/api/ingest', { method: 'POST', body: JSON.stringify(body) }),
  job: (jobId) => request(`/api/jobs/${encodeURIComponent(jobId)}`),
  overview: (params) => request(`/api/graph/overview${qs(params)}`),
  subgraph: (params) => request(`/api/graph/subgraph${qs(params)}`),
  node: (id) => request(`/api/nodes/${encodeURIComponent(id)}`),
  search: (params) => request(`/api/search${qs(params)}`),
  impact: (id, params) => request(`/api/impact/${encodeURIComponent(id)}${qs(params)}`),
  links: (params) => request(`/api/links${qs(params)}`),
  relink: (project) =>
    request('/api/links/relink', { method: 'POST', body: JSON.stringify({ project }) }),
  scenarios: (params) => request(`/api/scenarios${qs(params)}`),
  buildScenarios: (project) =>
    request('/api/scenarios', { method: 'POST', body: JSON.stringify({ project }) }),
  githubPrecheck: (repoUrl) =>
    request('/api/github/precheck', { method: 'POST', body: JSON.stringify({ repoUrl }) }),
  githubIngest: (body) =>
    request('/api/ingest/github', { method: 'POST', body: JSON.stringify(body) }),
  ask: (body) => request('/api/ask', { method: 'POST', body: JSON.stringify(body) }),
  askSuggestions: (project) => request(`/api/ask/suggestions${qs({ project })}`),
  nodeByPath: (params) => request(`/api/nodes/by-path${qs(params)}`),
};
