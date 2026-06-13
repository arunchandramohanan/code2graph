import { NavLink, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import Toasts from './components/Toasts';
import ProjectSelect from './components/ProjectSelect';
import Dashboard from './pages/Dashboard';
import GraphExplorer from './pages/GraphExplorer';
import SearchPage from './pages/SearchPage';
import ImpactPage from './pages/ImpactPage';
import LinksPage from './pages/LinksPage';
import ScenariosPage from './pages/ScenariosPage';
import AskPage from './pages/AskPage';

const NAV = [
  { to: '/', label: 'Dashboard', icon: '◫' },
  { to: '/graph', label: 'Graph Explorer', icon: '◉' },
  { to: '/search', label: 'Search', icon: '⌕' },
  { to: '/impact', label: 'Impact', icon: '⇶' },
  { to: '/links', label: 'API Links', icon: '⇄' },
  { to: '/scenarios', label: 'Scenarios', icon: '◈' },
  { to: '/ask', label: 'Ask', icon: '✦' },
];

export default function App() {
  return (
    <AppProvider>
      <div className="app-shell">
        <nav className="sidebar">
          <div className="logo">
            <span className="logo-mark">⬢</span> code<span className="logo-accent">2</span>graph
          </div>
          <div className="nav-links">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              >
                <span className="nav-icon">{item.icon}</span>
                {item.label}
              </NavLink>
            ))}
          </div>
          <div className="sidebar-footer">
            <label className="field-label">Project</label>
            <ProjectSelect />
          </div>
        </nav>
        <main className="main">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/graph" element={<GraphExplorer />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/impact" element={<ImpactPage />} />
            <Route path="/links" element={<LinksPage />} />
            <Route path="/scenarios" element={<ScenariosPage />} />
            <Route path="/ask" element={<AskPage />} />
          </Routes>
        </main>
        <Toasts />
      </div>
    </AppProvider>
  );
}
