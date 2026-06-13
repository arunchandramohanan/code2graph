export const LABEL_COLORS = {
  Controller: '#f59e0b',
  Service: '#10b981',
  Component: '#3b82f6',
  Endpoint: '#ef4444',
  ApiCall: '#ec4899',
  Entity: '#8b5cf6',
  Table: '#6b7280',
  DTO: '#14b8a6',
  Repository: '#a78bfa',
  Route: '#fb923c',
  Method: '#94a3b8',
  Application: '#eab308',
  Module: '#22d3ee',
  File: '#64748b',
  Class: '#60a5fa',
  Template: '#f472b6',
  Topic: '#fbbf24',
  Deployment: '#0ea5e9',
  Datasource: '#06b6d4',
  Scenario: '#f43f5e',
};

export const DEFAULT_COLOR = '#6b7280';

export function colorFor(label) {
  return LABEL_COLORS[label] || DEFAULT_COLOR;
}

export function shapeFor(stack) {
  if (stack === 'java') return 'round-rectangle';
  if (stack === 'infra') return 'hexagon';
  if (stack === 'system') return 'diamond';
  return 'ellipse';
}

export const NODE_LABELS = [
  'Application', 'Module', 'File', 'Class', 'Component', 'Service',
  'Controller', 'Endpoint', 'ApiCall', 'Method', 'DTO', 'Entity',
  'Table', 'Repository', 'Route', 'Template', 'Topic', 'Deployment',
  'Datasource', 'Scenario',
];

export const EDGE_TYPES = [
  'DECLARES', 'IMPORTS', 'INJECTS', 'CALLS', 'EXTENDS', 'IMPLEMENTS',
  'RENDERS', 'BINDS', 'USES_TEMPLATE', 'NAVIGATES_TO', 'EXPOSES',
  'HANDLED_BY', 'MAKES_CALL', 'INVOKES_API', 'ACCEPTS', 'RETURNS',
  'MAPS_TO', 'RELATES_TO', 'READS', 'WRITES', 'MANAGES',
  'PUBLISHES_TO', 'CONSUMES_FROM', 'DEPLOYED_AS', 'CONNECTS_TO',
  'USES_DATASOURCE', 'PROVIDED_BY', 'HOSTS', 'COVERS',
];

// 4+1 architectural view presets (server-side filters via ?view=)
export const VIEWS = [
  { key: '', name: 'Custom (filters)' },
  { key: 'logical', name: 'Logical view' },
  { key: 'development', name: 'Development view' },
  { key: 'process', name: 'Process view' },
  { key: 'physical', name: 'Physical view' },
  { key: 'scenarios', name: 'Scenarios (+1)' },
];

// Labels shown by default in the Graph Explorer architecture view.
export const DEFAULT_GRAPH_LABELS = [
  'Controller', 'Service', 'Component', 'Endpoint', 'ApiCall',
  'Entity', 'Table', 'DTO', 'Repository', 'Route',
];
