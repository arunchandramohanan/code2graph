import { useApp } from '../context/AppContext';

export default function ProjectSelect({ allowAll = true }) {
  const { project, setProject, projects } = useApp();
  return (
    <select
      className="select"
      value={project}
      onChange={(e) => setProject(e.target.value)}
      title="Active project"
    >
      {allowAll && <option value="">(all projects)</option>}
      {projects.map((p) => (
        <option key={p.name} value={p.name}>
          {p.name}
        </option>
      ))}
      {project && !projects.some((p) => p.name === project) && (
        <option value={project}>{project}</option>
      )}
    </select>
  );
}
