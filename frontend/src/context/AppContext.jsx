import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from '../api';

const AppContext = createContext(null);

const PROJECT_KEY = 'code2graph.project';

export function AppProvider({ children }) {
  const [project, setProjectState] = useState(() => {
    try {
      return localStorage.getItem(PROJECT_KEY) || '';
    } catch {
      return '';
    }
  });
  const [projects, setProjects] = useState([]);
  const [projectsError, setProjectsError] = useState(null);
  const [toasts, setToasts] = useState([]);
  const toastId = useRef(0);

  const setProject = useCallback((name) => {
    setProjectState(name);
    try {
      localStorage.setItem(PROJECT_KEY, name || '');
    } catch {
      /* localStorage unavailable */
    }
  }, []);

  const pushToast = useCallback((message, type = 'error') => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, message: String(message), type }]);
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 6000);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const list = await api.projects();
      const safe = Array.isArray(list) ? list : [];
      setProjects(safe);
      setProjectsError(null);
      // default to the first project when none is selected (or the saved one is gone)
      setProjectState((prev) => {
        const valid = prev && safe.some((p) => p.name === prev);
        const next = valid ? prev : safe[0]?.name || '';
        try {
          localStorage.setItem(PROJECT_KEY, next);
        } catch {
          /* localStorage unavailable */
        }
        return next;
      });
    } catch (err) {
      setProjects([]);
      setProjectsError(err.message);
    }
  }, []);

  useEffect(() => {
    refreshProjects();
  }, [refreshProjects]);

  const value = {
    project,
    setProject,
    projects,
    projectsError,
    refreshProjects,
    toasts,
    pushToast,
    removeToast,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}
