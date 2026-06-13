import { parseTemplate } from '@angular/compiler';

export interface TplEventBinding {
  event: string;
  expression: string;
}

export interface TplElementInfo {
  /** Tag name, lowercase. May be '' for tagless <ng-template> wrappers. */
  tag: string;
  /** All attribute-ish names appearing on the element (static attrs, bound inputs, outputs, template attrs). */
  attrNames: string[];
  events: TplEventBinding[];
}

export interface ParsedTpl {
  elements: TplElementInfo[];
  errors: string[];
}

/**
 * Parse an Angular HTML template (supports *ngIf/*ngFor as well as @if/@for/@switch
 * block syntax) and return a flat list of element-like nodes with their attribute
 * names and event bindings. Walks the template AST generically so all block types
 * (if/for/switch/defer/...) are traversed.
 */
export function parseAngularTemplate(content: string, url: string): ParsedTpl {
  const elements: TplElementInfo[] = [];
  const errors: string[] = [];
  let result: { nodes: unknown[]; errors?: unknown[] | null };
  try {
    result = parseTemplate(content, url, {
      preserveWhitespaces: false,
      leadingTriviaChars: [],
    }) as unknown as { nodes: unknown[]; errors?: unknown[] | null };
  } catch (e) {
    errors.push(`parseTemplate threw for ${url}: ${(e as Error).message}`);
    return { elements, errors };
  }
  if (result.errors && result.errors.length > 0) {
    for (const err of result.errors.slice(0, 5)) {
      errors.push(`template parse error in ${url}: ${String((err as { msg?: string }).msg ?? err)}`);
    }
  }
  const seen = new Set<object>();
  for (const n of result.nodes ?? []) walk(n, elements, seen);
  return { elements, errors };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function nameOf(v: unknown): string | null {
  if (isObj(v) && typeof v.name === 'string') return v.name;
  return null;
}

function eventExpression(ev: Record<string, unknown>): string {
  const handler = ev.handler as Record<string, unknown> | undefined;
  if (handler && typeof handler.source === 'string') return handler.source;
  const span = ev.handlerSpan as { toString?: () => string } | undefined;
  if (span && typeof span.toString === 'function') {
    try {
      const s = span.toString();
      if (typeof s === 'string') return s;
    } catch {
      /* ignore */
    }
  }
  return '';
}

function collectElement(node: Record<string, unknown>, out: TplElementInfo[]): void {
  // TmplAstElement has `name`; TmplAstTemplate has `tagName` (string|null) + `templateAttrs`.
  const isTemplate = Array.isArray(node.templateAttrs);
  const isElement =
    !isTemplate &&
    typeof node.name === 'string' &&
    Array.isArray(node.children) &&
    Array.isArray(node.attributes) &&
    Array.isArray(node.inputs) &&
    Array.isArray(node.outputs);
  if (!isTemplate && !isElement) return;

  const rawTag = isTemplate ? (node.tagName as string | null) : (node.name as string);
  const attrNames: string[] = [];
  for (const key of ['attributes', 'inputs', 'outputs', 'templateAttrs', 'references']) {
    const arr = node[key];
    if (!Array.isArray(arr)) continue;
    for (const a of arr) {
      const n = nameOf(a);
      if (n) attrNames.push(n);
    }
  }
  const events: TplEventBinding[] = [];
  const outputs = node.outputs;
  if (Array.isArray(outputs)) {
    for (const ev of outputs) {
      if (!isObj(ev)) continue;
      const n = nameOf(ev);
      if (!n) continue;
      events.push({ event: n, expression: eventExpression(ev).trim() });
    }
  }
  out.push({ tag: (rawTag ?? '').toLowerCase(), attrNames, events });
}

function walk(node: unknown, out: TplElementInfo[], seen: Set<object>): void {
  if (!isObj(node) || seen.has(node)) return;
  seen.add(node);
  collectElement(node, out);
  // Generic traversal: descend into any array-of-objects property and any object
  // property that itself carries a `children` array (covers IfBlockBranch,
  // SwitchBlockCase, ForLoopBlockEmpty, DeferredBlockPlaceholder, etc.).
  for (const key of Object.keys(node)) {
    if (key === 'sourceSpan' || key === 'startSourceSpan' || key === 'endSourceSpan' || key === 'i18n') continue;
    if (key === 'handler' || key === 'value' || key === 'expression') continue; // expression ASTs: not template nodes
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) walk(c, out, seen);
    } else if (isObj(v) && Array.isArray((v as Record<string, unknown>).children)) {
      walk(v, out, seen);
    }
  }
}

/**
 * Extract the top-level invoked method name from an event handler expression.
 * "save($event)" -> save ; "this.save()" -> save ; "open.emit(x)" -> null (member call);
 * bare "refresh" -> refresh.
 */
export function topLevelHandlerName(expression: string): string | null {
  const expr = expression.trim();
  let m = /^this\.([A-Za-z_$][\w$]*)\s*\(/.exec(expr);
  if (m) return m[1];
  m = /^([A-Za-z_$][\w$]*)\s*\(/.exec(expr);
  if (m) return m[1];
  m = /^([A-Za-z_$][\w$]*)$/.exec(expr);
  if (m) return m[1];
  return null;
}
