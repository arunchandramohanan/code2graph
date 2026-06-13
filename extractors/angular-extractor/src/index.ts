#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { extract } from './extractor.js';

function parseArgs(argv: string[]): { src?: string; project?: string; out?: string } {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--src' || a === '--project' || a === '--out') {
      out[a.slice(2)] = argv[++i];
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.src || !args.project || !args.out) {
    console.error('Usage: node dist/index.js --src <projectRoot> --project <name> --out <file.json>');
    process.exit(1);
  }
  const root = path.resolve(args.src);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch {
    console.error(`error: source root not readable: ${root}`);
    process.exit(1);
    return;
  }
  if (!stat.isDirectory()) {
    console.error(`error: source root is not a directory: ${root}`);
    process.exit(1);
  }

  let doc;
  try {
    doc = extract({ src: root, project: args.project });
  } catch (e) {
    // Never crash with invalid output: emit a minimal valid document instead.
    doc = {
      schemaVersion: '1.0' as const,
      stack: 'angular' as const,
      project: args.project,
      root,
      extractedAt: new Date().toISOString(),
      nodes: [],
      edges: [],
      warnings: [`fatal extraction error (emitted empty graph): ${(e as Error).stack ?? e}`],
    };
  }

  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(doc, null, 2), 'utf8');
  console.error(
    `angular-extractor: ${doc.nodes.length} nodes, ${doc.edges.length} edges, ` +
      `${doc.warnings.length} warnings -> ${args.out}`,
  );
  process.exit(0);
}

main();
