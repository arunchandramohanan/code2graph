import { createHash } from 'node:crypto';

export type PropValue = string | number | boolean | string[] | number[] | boolean[];

export interface GNode {
  id: string;
  label: string;
  fqn: string;
  name: string;
  stack: string;
  project: string;
  filePath: string;
  startLine: number;
  endLine: number;
  hash: string;
  props: Record<string, PropValue>;
}

export interface GEdge {
  source: string;
  target: string;
  type: string;
  props: Record<string, PropValue>;
}

export interface OutputDoc {
  schemaVersion: '1.0';
  stack: 'angular';
  project: string;
  root: string;
  extractedAt: string;
  nodes: GNode[];
  edges: GEdge[];
  warnings: string[];
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const STACK = 'angular';

export class GraphBuilder {
  readonly nodes = new Map<string, GNode>();
  readonly edges = new Map<string, GEdge>();
  readonly warnings: string[] = [];

  constructor(private readonly project: string) {}

  idOf(fqn: string): string {
    return `${STACK}:${fqn}`;
  }

  addNode(input: {
    label: string;
    fqn: string;
    name: string;
    filePath: string;
    startLine: number;
    endLine: number;
    sourceText: string;
    props?: Record<string, PropValue>;
  }): GNode {
    const id = this.idOf(input.fqn);
    const existing = this.nodes.get(id);
    if (existing) return existing;
    const node: GNode = {
      id,
      label: input.label,
      fqn: input.fqn,
      name: input.name,
      stack: STACK,
      project: this.project,
      filePath: input.filePath,
      startLine: input.startLine,
      endLine: input.endLine,
      hash: sha256(input.sourceText),
      props: input.props ?? {},
    };
    this.nodes.set(id, node);
    return node;
  }

  addEdge(sourceFqn: string, targetFqn: string, type: string, props: Record<string, PropValue> = {}): void {
    const source = this.idOf(sourceFqn);
    const target = this.idOf(targetFqn);
    const key = `${source}|${type}|${target}|${JSON.stringify(props)}`;
    if (this.edges.has(key)) return;
    this.edges.set(key, { source, target, type, props });
  }

  warn(message: string): void {
    if (this.warnings.length < 5000) this.warnings.push(message);
  }

  /** Drop edges whose endpoints are not present; per CONTRACTS.md rule. */
  finalize(root: string): OutputDoc {
    const nodes = [...this.nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
    const ids = new Set(nodes.map((n) => n.id));
    const edges: GEdge[] = [];
    for (const e of this.edges.values()) {
      if (!ids.has(e.source) || !ids.has(e.target)) {
        this.warn(`dropped edge ${e.type} ${e.source} -> ${e.target}: missing endpoint`);
        continue;
      }
      edges.push(e);
    }
    edges.sort(
      (a, b) =>
        a.source.localeCompare(b.source) || a.type.localeCompare(b.type) || a.target.localeCompare(b.target),
    );
    return {
      schemaVersion: '1.0',
      stack: 'angular',
      project: this.project,
      root,
      extractedAt: new Date().toISOString(),
      nodes,
      edges,
      warnings: this.warnings,
    };
  }
}
