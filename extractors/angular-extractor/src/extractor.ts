import fs from 'node:fs';
import path from 'node:path';
import {
  ArrayLiteralExpression,
  CallExpression,
  ClassDeclaration,
  Expression,
  Node,
  ObjectLiteralExpression,
  Project,
  PropertyDeclaration,
  ScriptTarget,
  SourceFile,
  SyntaxKind,
} from 'ts-morph';
import { GraphBuilder, OutputDoc, PropValue, sha256 } from './graph.js';
import { parseAngularTemplate, topLevelHandlerName } from './templates.js';

const HTTP_VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'request']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.angular', '.nx', 'coverage', 'out-tsc', 'tmp']);

interface MethodInfo {
  name: string;
  fqn: string;
  /** Node whose descendants are scanned for calls (method decl or property w/ function initializer). */
  node: Node;
  startLine: number;
  endLine: number;
  signature: string;
  returnType: string;
  params: string[];
  visibility: string;
  text: string;
}

interface InjectionInfo {
  via: string;
  typeName: string;
  targetFqn: string | null;
}

interface ClassInfo {
  decl: ClassDeclaration;
  sf: SourceFile;
  name: string;
  fqn: string;
  label: 'Component' | 'Service' | 'Module' | 'Class';
  kind: string;
  filePath: string;
  selector: string;
  templatePath: string;
  inlineTemplate: string | null;
  templateStartLine: number;
  templateEndLine: number;
  standaloneExplicit: boolean | null;
  standalone: boolean;
  inputs: string[];
  outputs: string[];
  methods: Map<string, MethodInfo>;
  injections: InjectionInfo[];
  httpRefs: Set<string>;
  extendsName: string | null;
  extendsFqn: string | null;
  implementsNames: string[];
  moduleDeclarationNames: string[];
}

interface ImportEntry {
  spec: string;
  exportedName: string; // 'default' for default imports
}

export interface ExtractOptions {
  src: string;
  project: string;
}

export function extract(opts: ExtractOptions): OutputDoc {
  const root = path.resolve(opts.src);
  const g = new GraphBuilder(opts.project);
  const appFqn = `app:${opts.project}`;

  g.addNode({
    label: 'Application',
    fqn: appFqn,
    name: opts.project,
    filePath: '',
    startLine: 0,
    endLine: 0,
    sourceText: `${opts.project}:${root}`,
  });

  const srcRoot = fs.existsSync(path.join(root, 'src')) ? path.join(root, 'src') : root;
  const tsFiles = listTsFiles(srcRoot);

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    compilerOptions: {
      allowJs: false,
      target: ScriptTarget.ES2022,
      experimentalDecorators: true,
      strict: false,
      noResolve: true,
    },
  });

  const sfByAbs = new Map<string, SourceFile>();
  for (const file of tsFiles) {
    try {
      const sf = project.addSourceFileAtPath(file);
      sfByAbs.set(path.resolve(file), sf);
    } catch (e) {
      g.warn(`failed to load ${rel(root, file)}: ${(e as Error).message}`);
    }
  }

  const aliasPaths = readTsconfigPaths(root, g);
  const importMaps = new Map<SourceFile, Map<string, ImportEntry>>();
  const classesByFile = new Map<string, ClassInfo[]>();
  const classByFqn = new Map<string, ClassInfo>();
  const ctx: Ctx = { root, g, sfByAbs, aliasPaths, importMaps, classesByFile, classByFqn };

  // ---- pass 1: collect classes -------------------------------------------------
  for (const sf of sfByAbs.values()) {
    const relPath = rel(root, sf.getFilePath());
    try {
      const infos: ClassInfo[] = [];
      for (const cls of sf.getClasses()) {
        const info = collectClass(ctx, sf, relPath, cls);
        if (info) {
          infos.push(info);
          classByFqn.set(info.fqn, info);
        }
      }
      classesByFile.set(relPath, infos);
    } catch (e) {
      g.warn(`failed to analyze ${relPath}: ${(e as Error).message}`);
      if (!classesByFile.has(relPath)) classesByFile.set(relPath, []);
    }
  }

  // ---- pass 2: cross-class resolution (DI targets, extends, standalone) --------
  const moduleDeclared = new Set<string>();
  for (const info of classByFqn.values()) {
    try {
      for (const inj of info.injections) {
        const target = resolveLocalClass(ctx, info.sf, inj.typeName);
        if (target) inj.targetFqn = target.fqn;
      }
      if (info.extendsName) {
        const target = resolveLocalClass(ctx, info.sf, info.extendsName);
        if (target) info.extendsFqn = target.fqn;
      }
      if (info.label === 'Module') {
        for (const declName of info.moduleDeclarationNames) {
          const target = resolveLocalClass(ctx, info.sf, declName);
          if (target) moduleDeclared.add(target.fqn);
        }
      }
    } catch (e) {
      g.warn(`resolution failed for ${info.fqn}: ${(e as Error).message}`);
    }
  }
  for (const info of classByFqn.values()) {
    info.standalone = info.standaloneExplicit ?? !moduleDeclared.has(info.fqn);
  }

  // ---- pass 3: emit file/class/method nodes + structural edges ------------------
  for (const sf of sfByAbs.values()) {
    const relPath = rel(root, sf.getFilePath());
    try {
      emitFileAndClasses(ctx, sf, relPath, appFqn);
    } catch (e) {
      g.warn(`failed to emit nodes for ${relPath}: ${(e as Error).message}`);
    }
  }

  // ---- pass 4: api calls + method call edges ------------------------------------
  for (const info of classByFqn.values()) {
    try {
      emitMethodBodies(ctx, info);
    } catch (e) {
      g.warn(`failed to analyze method bodies of ${info.fqn}: ${(e as Error).message}`);
    }
  }

  // ---- pass 5: routes ------------------------------------------------------------
  try {
    emitRoutes(ctx);
  } catch (e) {
    g.warn(`route extraction failed: ${(e as Error).message}`);
  }

  // ---- pass 6: templates (Template nodes, RENDERS, BINDS, USES_TEMPLATE) --------
  try {
    emitTemplates(ctx, appFqn);
  } catch (e) {
    g.warn(`template extraction failed: ${(e as Error).message}`);
  }

  return g.finalize(root);
}

interface Ctx {
  root: string;
  g: GraphBuilder;
  sfByAbs: Map<string, SourceFile>;
  aliasPaths: Array<{ prefix: string; target: string }>;
  importMaps: Map<SourceFile, Map<string, ImportEntry>>;
  classesByFile: Map<string, ClassInfo[]>;
  classByFqn: Map<string, ClassInfo>;
}

// ---------------------------------------------------------------------------
// filesystem helpers
// ---------------------------------------------------------------------------

function listTsFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      listTsFiles(full, out);
    } else if (
      e.isFile() &&
      e.name.endsWith('.ts') &&
      !e.name.endsWith('.spec.ts') &&
      !e.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

function rel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

function readTsconfigPaths(root: string, g: GraphBuilder): Array<{ prefix: string; target: string }> {
  const out: Array<{ prefix: string; target: string }> = [];
  for (const name of ['tsconfig.json', 'tsconfig.base.json', 'tsconfig.app.json']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    try {
      const raw = fs
        .readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/,\s*([}\]])/g, '$1');
      const json = JSON.parse(raw) as {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };
      const co = json.compilerOptions ?? {};
      const baseUrl = path.resolve(root, co.baseUrl ?? '.');
      for (const [alias, targets] of Object.entries(co.paths ?? {})) {
        if (!targets?.length) continue;
        out.push({
          prefix: alias.replace(/\*$/, ''),
          target: path.resolve(baseUrl, targets[0].replace(/\*$/, '')),
        });
      }
    } catch (e) {
      g.warn(`could not parse ${name}: ${(e as Error).message}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// import / symbol resolution (purely syntactic)
// ---------------------------------------------------------------------------

function importMapOf(ctx: Ctx, sf: SourceFile): Map<string, ImportEntry> {
  let map = ctx.importMaps.get(sf);
  if (map) return map;
  map = new Map();
  for (const imp of sf.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    const def = imp.getDefaultImport();
    if (def) map.set(def.getText(), { spec, exportedName: 'default' });
    for (const ni of imp.getNamedImports()) {
      const orig = ni.getName();
      const alias = ni.getAliasNode()?.getText() ?? orig;
      map.set(alias, { spec, exportedName: orig });
    }
  }
  ctx.importMaps.set(sf, map);
  return map;
}

function resolveModuleSpec(ctx: Ctx, fromSf: SourceFile, spec: string): SourceFile | null {
  let base: string | null = null;
  if (spec.startsWith('.')) {
    base = path.resolve(path.dirname(fromSf.getFilePath()), spec);
  } else {
    for (const alias of ctx.aliasPaths) {
      if (spec === alias.prefix.replace(/\/$/, '') || spec.startsWith(alias.prefix)) {
        const remainder = spec.startsWith(alias.prefix) ? spec.slice(alias.prefix.length) : '';
        base = path.resolve(alias.target + remainder);
        break;
      }
    }
  }
  if (!base) return null;
  const candidates = [
    base,
    `${base}.ts`,
    base.replace(/\.js$/, '.ts'),
    path.join(base, 'index.ts'),
  ];
  for (const c of candidates) {
    const sf = ctx.sfByAbs.get(path.resolve(c));
    if (sf) return sf;
  }
  return null;
}

/** Resolve a class name used in `sf` to a project-local ClassInfo (same file or relative import). */
function resolveLocalClass(ctx: Ctx, sf: SourceFile, name: string): ClassInfo | null {
  const relPath = rel(ctx.root, sf.getFilePath());
  const sameFile = (ctx.classesByFile.get(relPath) ?? []).find((c) => c.name === name);
  if (sameFile) return sameFile;
  const entry = importMapOf(ctx, sf).get(name);
  if (!entry) return null;
  const target = resolveModuleSpec(ctx, sf, entry.spec);
  if (!target) return null;
  const targetRel = rel(ctx.root, target.getFilePath());
  const wanted = entry.exportedName === 'default' ? null : entry.exportedName;
  const infos = ctx.classesByFile.get(targetRel) ?? [];
  if (wanted) return infos.find((c) => c.name === wanted) ?? null;
  return infos.find((c) => c.decl.isDefaultExport()) ?? null;
}

// ---------------------------------------------------------------------------
// class collection
// ---------------------------------------------------------------------------

function decoratorObjectArg(cls: ClassDeclaration, decName: string): ObjectLiteralExpression | null {
  const dec = cls.getDecorator(decName);
  if (!dec) return null;
  const arg = dec.getArguments()[0];
  return arg && Node.isObjectLiteralExpression(arg) ? arg : null;
}

function literalStringProp(obj: ObjectLiteralExpression, key: string): string | null {
  const p = obj.getProperty(key);
  if (!p || !Node.isPropertyAssignment(p)) return null;
  const init = p.getInitializer();
  if (init && (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init))) {
    return init.getLiteralText();
  }
  return null;
}

function boolProp(obj: ObjectLiteralExpression, key: string): boolean | null {
  const p = obj.getProperty(key);
  if (!p || !Node.isPropertyAssignment(p)) return null;
  const init = p.getInitializer();
  if (!init) return null;
  if (init.getKind() === SyntaxKind.TrueKeyword) return true;
  if (init.getKind() === SyntaxKind.FalseKeyword) return false;
  return null;
}

function baseTypeName(typeText: string): string {
  return typeText.replace(/<.*$/s, '').trim();
}

function classifyPlainClass(name: string, cls: ClassDeclaration): string {
  const heritage = [
    ...cls.getImplements().map((i) => i.getText()),
    cls.getExtends()?.getText() ?? '',
  ].join(' ');
  if (/Interceptor/.test(name) || /HttpInterceptor/.test(heritage)) return 'interceptor';
  if (/Guard/.test(name) || /CanActivate|CanDeactivate|CanMatch/.test(heritage)) return 'guard';
  if (/Resolver/.test(name) || /\bResolve\b/.test(heritage)) return 'resolver';
  if (/Pipe$/.test(name)) return 'pipe';
  if (/Directive$/.test(name)) return 'directive';
  return 'class';
}

function collectClass(ctx: Ctx, sf: SourceFile, relPath: string, cls: ClassDeclaration): ClassInfo | null {
  const name = cls.getName();
  if (!name) return null;
  const fqn = `${relPath}:${name}`;

  let label: ClassInfo['label'] = 'Class';
  let kind = 'class';
  if (cls.getDecorator('Component')) {
    label = 'Component';
    kind = 'component';
  } else if (cls.getDecorator('Injectable')) {
    label = 'Service';
    kind = 'service';
  } else if (cls.getDecorator('NgModule')) {
    label = 'Module';
    kind = 'module';
  } else if (cls.getDecorator('Directive')) {
    kind = 'directive';
  } else if (cls.getDecorator('Pipe')) {
    kind = 'pipe';
  } else {
    kind = classifyPlainClass(name, cls);
  }

  const info: ClassInfo = {
    decl: cls,
    sf,
    name,
    fqn,
    label,
    kind,
    filePath: relPath,
    selector: '',
    templatePath: '',
    inlineTemplate: null,
    templateStartLine: 0,
    templateEndLine: 0,
    standaloneExplicit: null,
    standalone: true,
    inputs: [],
    outputs: [],
    methods: new Map(),
    injections: [],
    httpRefs: new Set(),
    extendsName: null,
    extendsFqn: null,
    implementsNames: [],
    moduleDeclarationNames: [],
  };

  const ext = cls.getExtends();
  if (ext) info.extendsName = baseTypeName(ext.getExpression().getText());
  for (const impl of cls.getImplements()) info.implementsNames.push(baseTypeName(impl.getText()));

  // @Component metadata
  const compObj = decoratorObjectArg(cls, 'Component') ?? decoratorObjectArg(cls, 'Directive');
  if (compObj) {
    info.selector = literalStringProp(compObj, 'selector') ?? '';
    info.standaloneExplicit = boolProp(compObj, 'standalone');
    if (label === 'Component') {
      const templateUrl = literalStringProp(compObj, 'templateUrl');
      if (templateUrl) {
        const abs = path.resolve(path.dirname(sf.getFilePath()), templateUrl);
        info.templatePath = rel(ctx.root, abs);
      } else {
        const tplProp = compObj.getProperty('template');
        if (tplProp && Node.isPropertyAssignment(tplProp)) {
          const init = tplProp.getInitializer();
          if (init) {
            info.templateStartLine = init.getStartLineNumber();
            info.templateEndLine = init.getEndLineNumber();
            if (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init)) {
              info.inlineTemplate = init.getLiteralText();
            } else if (Node.isTemplateExpression(init)) {
              // template literal with ${} substitutions: best-effort strip
              info.inlineTemplate = init
                .getText()
                .replace(/^`|`$/g, '')
                .replace(/\$\{[^}]*\}/g, '');
              ctx.g.warn(`inline template of ${fqn} contains \${} substitutions; parsed best-effort`);
            }
          }
        }
      }
    }
  }

  // NgModule declarations (to derive standalone default for legacy components)
  const modObj = decoratorObjectArg(cls, 'NgModule');
  if (modObj) {
    const declProp = modObj.getProperty('declarations');
    if (declProp && Node.isPropertyAssignment(declProp)) {
      const init = declProp.getInitializer();
      if (init && Node.isArrayLiteralExpression(init)) {
        for (const el of init.getElements()) {
          if (Node.isIdentifier(el)) info.moduleDeclarationNames.push(el.getText());
        }
      }
    }
  }

  // properties: inputs/outputs, inject() DI, http refs, arrow-function methods
  for (const prop of cls.getProperties()) {
    const propName = prop.getName();
    if (prop.getDecorator('Input')) info.inputs.push(propName);
    if (prop.getDecorator('Output')) info.outputs.push(propName);
    const init = prop.getInitializer();
    if (!init) continue;
    if (Node.isCallExpression(init)) {
      const exprText = init.getExpression().getText();
      if (exprText === 'input' || exprText === 'input.required') info.inputs.push(propName);
      else if (exprText === 'model' || exprText === 'model.required') info.inputs.push(propName);
      else if (exprText === 'output') info.outputs.push(propName);
      else if (exprText === 'inject') {
        const arg = init.getArguments()[0];
        if (arg) {
          const typeName = baseTypeName(arg.getText());
          info.injections.push({ via: propName, typeName, targetFqn: null });
          if (typeName === 'HttpClient') info.httpRefs.add(propName);
        }
      }
    } else if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
      addPropertyMethod(info, prop, init);
    }
    // also recognize `http: HttpClient` typed properties
    const tn = prop.getTypeNode();
    if (tn && baseTypeName(tn.getText()) === 'HttpClient') info.httpRefs.add(propName);
  }

  // constructor DI
  const ctor = cls.getConstructors()[0];
  if (ctor) {
    for (const p of ctor.getParameters()) {
      const tn = p.getTypeNode();
      if (!tn) continue;
      const typeName = baseTypeName(tn.getText());
      if (!/^[A-Za-z_$][\w$]*$/.test(typeName)) continue;
      info.injections.push({ via: p.getName(), typeName, targetFqn: null });
      if (typeName === 'HttpClient') info.httpRefs.add(p.getName());
    }
    // `this.x = inject(Y)` inside constructor body
    for (const bin of ctor.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      if (bin.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
      const left = bin.getLeft();
      const right = bin.getRight();
      if (
        Node.isPropertyAccessExpression(left) &&
        Node.isThisExpression(left.getExpression()) &&
        Node.isCallExpression(right) &&
        right.getExpression().getText() === 'inject'
      ) {
        const arg = right.getArguments()[0];
        if (arg) {
          const typeName = baseTypeName(arg.getText());
          info.injections.push({ via: left.getName(), typeName, targetFqn: null });
          if (typeName === 'HttpClient') info.httpRefs.add(left.getName());
        }
      }
    }
  }

  // methods
  for (const m of cls.getMethods()) {
    const mName = m.getName();
    const params = m.getParameters().map((p) => `${p.getName()}:${p.getTypeNode()?.getText() ?? 'any'}`);
    const paramSig = m.getParameters().map((p) => p.getText()).join(', ');
    const returnType = m.getReturnTypeNode()?.getText() ?? '';
    info.methods.set(mName, {
      name: mName,
      fqn: `${fqn}#${mName}`,
      node: m,
      startLine: m.getStartLineNumber(),
      endLine: m.getEndLineNumber(),
      signature: `${mName}(${paramSig})${returnType ? `: ${returnType}` : ''}`,
      returnType,
      params,
      visibility: m.getScope(),
      text: m.getText(),
    });
  }

  return info;
}

function addPropertyMethod(info: ClassInfo, prop: PropertyDeclaration, fn: Node): void {
  const name = prop.getName();
  let params: string[] = [];
  let paramSig = '';
  let returnType = '';
  if (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn)) {
    params = fn.getParameters().map((p) => `${p.getName()}:${p.getTypeNode()?.getText() ?? 'any'}`);
    paramSig = fn.getParameters().map((p) => p.getText()).join(', ');
    returnType = fn.getReturnTypeNode()?.getText() ?? '';
  }
  info.methods.set(name, {
    name,
    fqn: `${info.fqn}#${name}`,
    node: prop,
    startLine: prop.getStartLineNumber(),
    endLine: prop.getEndLineNumber(),
    signature: `${name}(${paramSig})${returnType ? `: ${returnType}` : ''}`,
    returnType,
    params,
    visibility: prop.getScope(),
    text: prop.getText(),
  });
}

// ---------------------------------------------------------------------------
// node emission (files, classes, methods) + structural edges
// ---------------------------------------------------------------------------

function emitFileAndClasses(ctx: Ctx, sf: SourceFile, relPath: string, appFqn: string): void {
  const { g } = ctx;
  const text = sf.getFullText();
  g.addNode({
    label: 'File',
    fqn: relPath,
    name: path.basename(relPath),
    filePath: relPath,
    startLine: 1,
    endLine: sf.getEndLineNumber(),
    sourceText: text,
  });
  g.addEdge(appFqn, relPath, 'DECLARES');

  // IMPORTS edges (project-local only)
  for (const imp of sf.getImportDeclarations()) {
    const target = resolveModuleSpec(ctx, sf, imp.getModuleSpecifierValue());
    if (target) g.addEdge(relPath, rel(ctx.root, target.getFilePath()), 'IMPORTS');
  }

  for (const info of ctx.classesByFile.get(relPath) ?? []) {
    const props: Record<string, PropValue> = {};
    if (info.label === 'Component') {
      props.selector = info.selector;
      props.templatePath = info.templatePath;
      props.standalone = info.standalone;
      props.inputs = info.inputs;
      props.outputs = info.outputs;
    } else if (info.label === 'Class') {
      props.kind = info.kind;
      props.fields = info.decl
        .getProperties()
        .map((p) => `${p.getName()}:${p.getTypeNode()?.getText() ?? ''}`);
    }
    g.addNode({
      label: info.label,
      fqn: info.fqn,
      name: info.name,
      filePath: relPath,
      startLine: info.decl.getStartLineNumber(),
      endLine: info.decl.getEndLineNumber(),
      sourceText: info.decl.getText(),
      props,
    });
    g.addEdge(relPath, info.fqn, 'DECLARES');

    for (const m of info.methods.values()) {
      g.addNode({
        label: 'Method',
        fqn: m.fqn,
        name: m.name,
        filePath: relPath,
        startLine: m.startLine,
        endLine: m.endLine,
        sourceText: m.text,
        props: {
          signature: m.signature,
          returnType: m.returnType,
          params: m.params,
          visibility: m.visibility,
        },
      });
      g.addEdge(info.fqn, m.fqn, 'DECLARES');
    }

    for (const inj of info.injections) {
      if (inj.targetFqn) g.addEdge(info.fqn, inj.targetFqn, 'INJECTS', { via: inj.via });
    }
    if (info.extendsFqn) g.addEdge(info.fqn, info.extendsFqn, 'EXTENDS');
    for (const implName of info.implementsNames) {
      const target = resolveLocalClass(ctx, sf, implName);
      if (target) g.addEdge(info.fqn, target.fqn, 'IMPLEMENTS');
    }
  }
}

// ---------------------------------------------------------------------------
// method bodies: ApiCall nodes (MAKES_CALL) and CALLS edges
// ---------------------------------------------------------------------------

function emitMethodBodies(ctx: Ctx, info: ClassInfo): void {
  const { g } = ctx;
  for (const m of info.methods.values()) {
    let callOrdinal = 0;
    for (const call of m.node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) continue;
      const memberName = callee.getName();
      const recv = callee.getExpression();

      // --- HttpClient API calls ---
      if (HTTP_VERBS.has(memberName) && isHttpReceiver(recv, info)) {
        callOrdinal += 1;
        emitApiCall(ctx, info, m, call, memberName, callOrdinal);
        continue;
      }

      // --- this.method() -> own/inherited method ---
      if (Node.isThisExpression(recv)) {
        const target = findMethodInChain(ctx, info, memberName);
        if (target) g.addEdge(m.fqn, target, 'CALLS', { line: call.getStartLineNumber() });
        continue;
      }

      // --- this.dep.method() where dep is an injected project-local class ---
      if (Node.isPropertyAccessExpression(recv) && Node.isThisExpression(recv.getExpression())) {
        const depName = recv.getName();
        const inj = info.injections.find((i) => i.via === depName && i.targetFqn);
        if (!inj?.targetFqn) continue;
        const targetClass = ctx.classByFqn.get(inj.targetFqn);
        if (!targetClass) continue;
        const target = findMethodInChain(ctx, targetClass, memberName);
        if (target) g.addEdge(m.fqn, target, 'CALLS', { line: call.getStartLineNumber() });
      }
    }
  }
}

function isHttpReceiver(recv: Expression, info: ClassInfo): boolean {
  if (
    Node.isPropertyAccessExpression(recv) &&
    Node.isThisExpression(recv.getExpression()) &&
    info.httpRefs.has(recv.getName())
  ) {
    return true;
  }
  if (
    Node.isCallExpression(recv) &&
    recv.getExpression().getText() === 'inject' &&
    recv.getArguments()[0]?.getText() === 'HttpClient'
  ) {
    return true;
  }
  return false;
}

function findMethodInChain(ctx: Ctx, info: ClassInfo, methodName: string): string | null {
  let current: ClassInfo | undefined | null = info;
  for (let depth = 0; current && depth < 10; depth++) {
    const m = current.methods.get(methodName);
    if (m) return m.fqn;
    current = current.extendsFqn ? ctx.classByFqn.get(current.extendsFqn) : null;
  }
  return null;
}

function emitApiCall(
  ctx: Ctx,
  info: ClassInfo,
  m: MethodInfo,
  call: CallExpression,
  verb: string,
  ordinal: number,
): void {
  const { g } = ctx;
  const args = call.getArguments();
  let httpMethod = '';
  let urlArg: Node | undefined;
  if (verb === 'request') {
    const first = args[0];
    if (first && (Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first))) {
      httpMethod = first.getLiteralText().toUpperCase();
    }
    urlArg = args[1];
  } else {
    httpMethod = verb.toUpperCase();
    urlArg = args[0];
  }

  const urlExpression = urlArg ? urlArg.getText() : '';
  let resolvedPath = '';
  if (urlArg && Node.isExpression(urlArg)) {
    try {
      resolvedPath = resolveUrlExpression(ctx, info, urlArg, 0) ?? '';
    } catch (e) {
      g.warn(`url resolution failed in ${m.fqn}: ${(e as Error).message}`);
    }
  }
  const normalizedPath = normalizePath(resolvedPath);
  const fqn = `${m.fqn}@call${ordinal}`;
  g.addNode({
    label: 'ApiCall',
    fqn,
    name: `${httpMethod || 'REQUEST'} ${normalizedPath || urlExpression}`.trim(),
    filePath: info.filePath,
    startLine: call.getStartLineNumber(),
    endLine: call.getEndLineNumber(),
    sourceText: call.getText(),
    props: {
      httpMethod,
      urlExpression,
      resolvedPath,
      normalizedPath,
      inMethod: m.fqn,
    },
  });
  g.addEdge(m.fqn, fqn, 'MAKES_CALL');
}

// ---------------------------------------------------------------------------
// static URL resolution
// ---------------------------------------------------------------------------

function unwrapExpression(expr: Expression): Expression {
  let cur = expr;
  for (;;) {
    if (Node.isParenthesizedExpression(cur) || Node.isAsExpression(cur) || Node.isNonNullExpression(cur)) {
      cur = cur.getExpression();
    } else {
      return cur;
    }
  }
}

/**
 * Best-effort static resolution of a URL expression. Returns a string in which
 * unresolvable dynamic parts are replaced by `{*}`, or null when nothing at all
 * could be resolved.
 */
function resolveUrlExpression(ctx: Ctx, info: ClassInfo, expr: Expression, depth: number): string | null {
  if (depth > 8) return null;
  const e = unwrapExpression(expr);

  if (Node.isStringLiteral(e) || Node.isNoSubstitutionTemplateLiteral(e)) return e.getLiteralText();

  if (Node.isTemplateExpression(e)) {
    let out = e.getHead().getLiteralText();
    for (const span of e.getTemplateSpans()) {
      const resolved = resolveUrlExpression(ctx, info, span.getExpression(), depth + 1);
      out += resolved ?? '{*}';
      out += span.getLiteral().getLiteralText();
    }
    return out;
  }

  if (Node.isBinaryExpression(e) && e.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
    const left = resolveUrlExpression(ctx, info, e.getLeft(), depth + 1);
    const right = resolveUrlExpression(ctx, info, e.getRight(), depth + 1);
    if (left === null && right === null) return null;
    return (left ?? '{*}') + (right ?? '{*}');
  }

  if (Node.isPropertyAccessExpression(e)) {
    const base = e.getExpression();
    const propName = e.getName();
    if (Node.isThisExpression(base)) {
      // this.base -> class property initializer (walk extends chain)
      let current: ClassInfo | undefined | null = info;
      for (let d = 0; current && d < 6; d++) {
        const prop = current.decl.getProperty(propName);
        const init = prop?.getInitializer();
        if (init) return resolveUrlExpression(ctx, current, init, depth + 1);
        current = current.extendsFqn ? ctx.classByFqn.get(current.extendsFqn) : null;
      }
      return null;
    }
    if (Node.isIdentifier(base)) {
      // environment.apiUrl style: resolve `environment` to an object literal
      const objInit = resolveIdentifierInitializer(ctx, info, base.getText(), e);
      if (objInit) {
        const unwrapped = unwrapExpression(objInit);
        if (Node.isObjectLiteralExpression(unwrapped)) {
          const p = unwrapped.getProperty(propName);
          if (p && Node.isPropertyAssignment(p)) {
            const init = p.getInitializer();
            if (init) return resolveUrlExpression(ctx, info, init, depth + 1);
          }
        }
      }
      return null;
    }
    return null;
  }

  if (Node.isIdentifier(e)) {
    const init = resolveIdentifierInitializer(ctx, info, e.getText(), e);
    if (init) return resolveUrlExpression(ctx, info, init, depth + 1);
    return null;
  }

  // URL-builder helper calls — JHipster's
  // `applicationConfigService.getEndpointFor('api/foo'[, 'microservice'])` and similar.
  // The first string argument carries the path; later args (microservice name) are ignored.
  if (Node.isCallExpression(e)) {
    const callee = e.getExpression();
    const methodName = Node.isPropertyAccessExpression(callee)
      ? callee.getName()
      : Node.isIdentifier(callee)
        ? callee.getText()
        : '';
    if (/endpoint|resourceurl|apiurl|buildurl|tourl/i.test(methodName)) {
      const args = e.getArguments();
      if (args.length > 0) {
        const resolved = resolveUrlExpression(ctx, info, args[0] as Expression, depth + 1);
        if (resolved !== null) return resolved;
      }
    }
    return null;
  }

  return null;
}

/** Find the initializer expression of an identifier: enclosing-function local const,
 *  file-level const, or an imported const from a project file. */
function resolveIdentifierInitializer(
  ctx: Ctx,
  info: ClassInfo,
  name: string,
  usage: Node,
): Expression | null {
  // local declarations in enclosing function-like scopes
  let scope: Node | undefined = usage.getParent();
  while (scope) {
    if (
      Node.isMethodDeclaration(scope) ||
      Node.isFunctionDeclaration(scope) ||
      Node.isArrowFunction(scope) ||
      Node.isFunctionExpression(scope) ||
      Node.isConstructorDeclaration(scope)
    ) {
      for (const vd of scope.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        if (vd.getName() === name) {
          const init = vd.getInitializer();
          if (init) return init;
        }
      }
    }
    scope = scope.getParent();
  }
  const sf = usage.getSourceFile();
  // file-level const
  const fileVd = sf.getVariableDeclaration(name);
  if (fileVd) {
    const init = fileVd.getInitializer();
    if (init) return init;
  }
  // imported const from project file
  const entry = importMapOf(ctx, sf).get(name);
  if (entry && entry.exportedName !== 'default') {
    const target = resolveModuleSpec(ctx, sf, entry.spec);
    const vd = target?.getVariableDeclaration(entry.exportedName);
    const init = vd?.getInitializer();
    if (init) return init;
  }
  return null;
}

/** Normalization per CONTRACTS.md section 3. */
export function normalizePath(resolved: string): string {
  if (!resolved) return '';
  let p = resolved.split('?')[0].split('#')[0];
  p = p.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  p = p.replace(/\$\{[^}]*\}/g, '{*}');
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/{2,}/g, '/');
  const segments = p
    .split('/')
    .filter((s) => s !== '')
    .map((s) => (s.includes('{*}') || s.startsWith(':') || s.includes('{') ? '{*}' : s.toLowerCase()));
  return `/${segments.join('/')}`.replace(/\/$/, '') || '/';
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

function emitRoutes(ctx: Ctx): void {
  const processedArrays = new Set<ArrayLiteralExpression>();
  const topLevel: ArrayLiteralExpression[] = [];

  const files = [...ctx.sfByAbs.values()].sort((a, b) => a.getFilePath().localeCompare(b.getFilePath()));
  for (const sf of files) {
    try {
      // Routes-typed consts
      for (const vd of sf.getVariableDeclarations()) {
        const typeText = vd.getTypeNode()?.getText() ?? '';
        if (!/\bRoutes\b|\bRoute\s*\[\s*\]/.test(typeText)) continue;
        const init = vd.getInitializer();
        if (init && Node.isArrayLiteralExpression(init) && !nestedInRouteArray(init)) {
          topLevel.push(init);
        }
      }
      // RouterModule.forRoot/forChild(...) and provideRouter(...)
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const exprText = call.getExpression().getText();
        if (!/(?:^|\.)RouterModule\.(forRoot|forChild)$/.test(exprText) && exprText !== 'provideRouter') {
          continue;
        }
        let arg: Node | undefined = call.getArguments()[0];
        if (arg && Node.isIdentifier(arg)) {
          const vd = sf.getVariableDeclaration(arg.getText());
          const init = vd?.getInitializer();
          if (init && Node.isArrayLiteralExpression(init)) arg = init;
        }
        if (arg && Node.isArrayLiteralExpression(arg)) topLevel.push(arg);
      }
    } catch (e) {
      ctx.g.warn(`route scan failed in ${rel(ctx.root, sf.getFilePath())}: ${(e as Error).message}`);
    }
  }

  const usedFqns = new Map<string, number>();
  for (const arr of topLevel) {
    if (processedArrays.has(arr)) continue;
    walkRouteArray(ctx, arr, '', processedArrays, usedFqns, new Set<string>());
  }
}

function nestedInRouteArray(arr: ArrayLiteralExpression): boolean {
  // skip arrays that are `children: [...]` of another route object (handled via recursion)
  const parent = arr.getParent();
  return Node.isPropertyAssignment(parent) && parent.getName() === 'children';
}

function joinRoutePath(parent: string, child: string): string {
  return [parent, child].filter((s) => s !== '').join('/');
}

function walkRouteArray(
  ctx: Ctx,
  arr: ArrayLiteralExpression,
  prefix: string,
  processedArrays: Set<ArrayLiteralExpression>,
  usedFqns: Map<string, number>,
  lazyVisited: Set<string>,
): void {
  processedArrays.add(arr);
  const { g } = ctx;
  const sf = arr.getSourceFile();
  const relPath = rel(ctx.root, sf.getFilePath());

  for (const el of arr.getElements()) {
    if (!Node.isObjectLiteralExpression(el)) continue;
    try {
      const routePathRaw = literalStringProp(el, 'path');
      const fullPath = joinRoutePath(prefix, routePathRaw ?? '');
      const redirectTo = literalStringProp(el, 'redirectTo') ?? '';

      let componentFqn = '';
      let lazyImport = '';

      const compProp = el.getProperty('component');
      if (compProp && Node.isPropertyAssignment(compProp)) {
        const init = compProp.getInitializer();
        if (init && Node.isIdentifier(init)) {
          const target = resolveLocalClass(ctx, sf, init.getText());
          if (target) componentFqn = target.fqn;
          else g.warn(`route '${fullPath}': could not resolve component ${init.getText()} in ${relPath}`);
        }
      }

      const loadCompProp = el.getProperty('loadComponent');
      if (loadCompProp && Node.isPropertyAssignment(loadCompProp)) {
        const lazy = resolveLazyImport(ctx, sf, loadCompProp.getInitializer());
        if (lazy) {
          lazyImport = lazy.spec;
          if (lazy.targetSf && lazy.exportName) {
            const targetRel = rel(ctx.root, lazy.targetSf.getFilePath());
            const target = (ctx.classesByFile.get(targetRel) ?? []).find(
              (c) => c.name === lazy.exportName || (lazy.exportName === 'default' && c.decl.isDefaultExport()),
            );
            if (target) componentFqn = target.fqn;
          }
          if (!componentFqn) g.warn(`route '${fullPath}': could not resolve loadComponent target ${lazyImport}`);
        }
      }

      // unique route fqn
      let fqn = `route:${fullPath}`;
      const n = usedFqns.get(fqn) ?? 0;
      usedFqns.set(fqn, n + 1);
      if (n > 0) fqn = `${fqn}#${n + 1}`;

      const props: Record<string, PropValue> = {
        routePath: fullPath,
        componentFqn,
      };
      if (redirectTo) props.redirectTo = redirectTo;
      if (lazyImport) props.lazyImport = lazyImport;

      g.addNode({
        label: 'Route',
        fqn,
        name: fullPath || '/',
        filePath: relPath,
        startLine: el.getStartLineNumber(),
        endLine: el.getEndLineNumber(),
        sourceText: el.getText(),
        props,
      });
      if (componentFqn && ctx.classByFqn.has(componentFqn)) {
        g.addEdge(fqn, componentFqn, 'NAVIGATES_TO');
      }

      // children: [...]
      const childrenProp = el.getProperty('children');
      if (childrenProp && Node.isPropertyAssignment(childrenProp)) {
        const init = childrenProp.getInitializer();
        if (init && Node.isArrayLiteralExpression(init)) {
          walkRouteArray(ctx, init, fullPath, processedArrays, usedFqns, lazyVisited);
        }
      }

      // loadChildren: () => import('./x.routes').then(m => m.routes)
      const loadChildrenProp = el.getProperty('loadChildren');
      if (loadChildrenProp && Node.isPropertyAssignment(loadChildrenProp)) {
        const lazy = resolveLazyImport(ctx, sf, loadChildrenProp.getInitializer());
        if (lazy?.targetSf) {
          const key = `${lazy.targetSf.getFilePath()}|${fullPath}`;
          if (!lazyVisited.has(key)) {
            lazyVisited.add(key);
            const childArr = findRoutesArrayInFile(lazy.targetSf, lazy.exportName);
            if (childArr) {
              walkRouteArray(ctx, childArr, fullPath, processedArrays, usedFqns, lazyVisited);
            } else {
              g.warn(`route '${fullPath}': could not find routes array in ${lazy.spec}`);
            }
          }
        } else if (lazy) {
          g.warn(`route '${fullPath}': could not resolve loadChildren target ${lazy.spec}`);
        }
      }
    } catch (e) {
      g.warn(`failed to process a route in ${relPath}: ${(e as Error).message}`);
    }
  }
}

interface LazyTarget {
  spec: string;
  targetSf: SourceFile | null;
  exportName: string | null;
}

/** Resolve `() => import('./x').then(m => m.Y)` (or `m => m.default`). */
function resolveLazyImport(ctx: Ctx, sf: SourceFile, init: Node | undefined): LazyTarget | null {
  if (!init) return null;
  const importCalls = init
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((c) => c.getExpression().getKind() === SyntaxKind.ImportKeyword);
  const importCall = importCalls[0];
  if (!importCall) return null;
  const specArg = importCall.getArguments()[0];
  if (!specArg || !(Node.isStringLiteral(specArg) || Node.isNoSubstitutionTemplateLiteral(specArg))) return null;
  const spec = specArg.getLiteralText();
  const targetSf = resolveModuleSpec(ctx, sf, spec);

  // find `m.X` in a .then(...) callback (or direct property access on the promise result)
  let exportName: string | null = null;
  for (const arrow of [
    ...init.getDescendantsOfKind(SyntaxKind.ArrowFunction),
    ...init.getDescendantsOfKind(SyntaxKind.FunctionExpression),
  ]) {
    if (arrow.getDescendantsOfKind(SyntaxKind.CallExpression).includes(importCall)) continue;
    const paramName = arrow.getParameters()[0]?.getName();
    if (!paramName) continue;
    for (const pa of arrow.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      if (pa.getExpression().getText() === paramName) {
        exportName = pa.getName();
        break;
      }
    }
    if (exportName) break;
  }
  return { spec, targetSf, exportName };
}

function findRoutesArrayInFile(sf: SourceFile, exportName: string | null): ArrayLiteralExpression | null {
  if (exportName && exportName !== 'default') {
    const vd = sf.getVariableDeclaration(exportName);
    const init = vd?.getInitializer();
    if (init && Node.isArrayLiteralExpression(init)) return init;
  }
  // default export
  for (const ea of sf.getExportAssignments()) {
    const expr = ea.getExpression();
    if (Node.isArrayLiteralExpression(expr)) return expr;
    if (Node.isIdentifier(expr)) {
      const vd = sf.getVariableDeclaration(expr.getText());
      const init = vd?.getInitializer();
      if (init && Node.isArrayLiteralExpression(init)) return init;
    }
  }
  // fallback: any Routes-typed const
  for (const vd of sf.getVariableDeclarations()) {
    const typeText = vd.getTypeNode()?.getText() ?? '';
    if (/\bRoutes\b|\bRoute\s*\[\s*\]/.test(typeText)) {
      const init = vd.getInitializer();
      if (init && Node.isArrayLiteralExpression(init)) return init;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// templates: Template nodes, USES_TEMPLATE, RENDERS, BINDS
// ---------------------------------------------------------------------------

interface SelectorEntry {
  fqn: string;
  selector: string;
}

function buildSelectorMaps(ctx: Ctx): { tags: Map<string, SelectorEntry>; attrs: Map<string, SelectorEntry> } {
  const tags = new Map<string, SelectorEntry>();
  const attrs = new Map<string, SelectorEntry>();
  const components = [...ctx.classByFqn.values()]
    .filter((c) => c.label === 'Component' && c.selector)
    .sort((a, b) => a.fqn.localeCompare(b.fqn));
  for (const c of components) {
    for (const part of c.selector.split(',')) {
      const sel = part.trim();
      if (!sel) continue;
      const attrMatches = [...sel.matchAll(/\[([^\]=]+)(?:=[^\]]*)?\]/g)].map((m) => m[1].trim());
      if (attrMatches.length > 0) {
        for (const a of attrMatches) {
          if (!attrs.has(a)) attrs.set(a, { fqn: c.fqn, selector: sel });
        }
      } else {
        const tag = sel.replace(/[.#:].*$/, '').trim().toLowerCase();
        if (tag && !tags.has(tag)) tags.set(tag, { fqn: c.fqn, selector: sel });
      }
    }
  }
  return { tags, attrs };
}

function emitTemplates(ctx: Ctx, appFqn: string): void {
  const { g } = ctx;
  const { tags, attrs } = buildSelectorMaps(ctx);
  const htmlFilesEmitted = new Set<string>();

  const components = [...ctx.classByFqn.values()]
    .filter((c) => c.label === 'Component')
    .sort((a, b) => a.fqn.localeCompare(b.fqn));

  for (const comp of components) {
    try {
      let content: string | null = null;
      let tplFilePath = comp.filePath;
      let startLine = comp.templateStartLine;
      let endLine = comp.templateEndLine;

      if (comp.templatePath) {
        const abs = path.resolve(ctx.root, comp.templatePath);
        if (fs.existsSync(abs)) {
          content = fs.readFileSync(abs, 'utf8');
          tplFilePath = comp.templatePath;
          startLine = 1;
          endLine = content.split('\n').length;
          if (!htmlFilesEmitted.has(comp.templatePath)) {
            htmlFilesEmitted.add(comp.templatePath);
            g.addNode({
              label: 'File',
              fqn: comp.templatePath,
              name: path.basename(comp.templatePath),
              filePath: comp.templatePath,
              startLine: 1,
              endLine,
              sourceText: content,
            });
            g.addEdge(appFqn, comp.templatePath, 'DECLARES');
          }
        } else {
          g.warn(`templateUrl of ${comp.fqn} not found: ${comp.templatePath}`);
        }
      } else if (comp.inlineTemplate !== null) {
        content = comp.inlineTemplate;
      }

      if (content === null) continue;

      const tplFqn = `${comp.fqn}:template`;
      g.addNode({
        label: 'Template',
        fqn: tplFqn,
        name: `${comp.name} template`,
        filePath: tplFilePath,
        startLine,
        endLine,
        sourceText: content,
      });
      g.addEdge(comp.fqn, tplFqn, 'USES_TEMPLATE');

      const parsed = parseAngularTemplate(content, tplFilePath);
      for (const err of parsed.errors) g.warn(err);

      for (const el of parsed.elements) {
        // RENDERS: tag selector match
        const tagEntry = el.tag ? tags.get(el.tag) : undefined;
        if (tagEntry) {
          g.addEdge(comp.fqn, tagEntry.fqn, 'RENDERS', { viaSelector: tagEntry.selector });
        }
        // RENDERS: attribute selector match
        for (const attrName of el.attrNames) {
          const attrEntry = attrs.get(attrName);
          if (attrEntry) g.addEdge(comp.fqn, attrEntry.fqn, 'RENDERS', { viaSelector: attrEntry.selector });
        }
        // BINDS: event handler -> component method
        for (const ev of el.events) {
          const handlerName = topLevelHandlerName(ev.expression);
          if (!handlerName) continue;
          const targetMethod = findMethodInChain(ctx, comp, handlerName);
          if (!targetMethod) continue;
          g.addEdge(tplFqn, targetMethod, 'BINDS', { event: ev.event, expression: ev.expression });
        }
      }
    } catch (e) {
      g.warn(`template processing failed for ${comp.fqn}: ${(e as Error).message}`);
    }
  }
}
