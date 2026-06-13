package dev.code2graph.javaextractor;

import com.github.javaparser.JavaParser;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.*;
import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.expr.ArrayInitializerExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.NormalAnnotationExpr;
import com.github.javaparser.ast.expr.SingleMemberAnnotationExpr;
import com.github.javaparser.ast.expr.StringLiteralExpr;
import com.github.javaparser.ast.nodeTypes.NodeWithAnnotations;
import com.github.javaparser.ast.type.ClassOrInterfaceType;
import com.github.javaparser.ast.type.Type;
import com.github.javaparser.resolution.declarations.ResolvedMethodDeclaration;
import com.github.javaparser.symbolsolver.JavaSymbolSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.CombinedTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.JavaParserTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.ReflectionTypeSolver;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.stream.Collectors;
import java.util.stream.Stream;

public class Extractor {

    private final Path root;
    private final Model.Doc doc;
    private final Map<String, TypeInfo> projectTypes = new LinkedHashMap<>(); // fqn -> info
    private final Map<String, String> simpleToFqn = new HashMap<>();          // simple name -> fqn (first wins)
    private final List<Parsed> parsed = new ArrayList<>();

    private static final Set<String> CONTROLLER_ANN = Set.of("RestController", "Controller");
    private static final Set<String> SERVICE_ANN = Set.of("Service", "Component", "Configuration");
    private static final Set<String> REPO_INTERFACES = Set.of(
            "JpaRepository", "CrudRepository", "ListCrudRepository", "ListPagingAndSortingRepository",
            "PagingAndSortingRepository", "ReactiveCrudRepository", "MongoRepository");
    private static final Map<String, String> MAPPING_ANN = Map.of(
            "GetMapping", "GET", "PostMapping", "POST", "PutMapping", "PUT",
            "DeleteMapping", "DELETE", "PatchMapping", "PATCH");
    private static final Set<String> RELATION_ANN = Set.of(
            "OneToMany", "ManyToOne", "OneToOne", "ManyToMany");

    private record TypeInfo(String fqn, String label, String fileId, TypeDeclaration<?> decl) {}
    private record Parsed(CompilationUnit cu, Path file, String relPath) {}

    public Extractor(Path root, String project) {
        this.root = root;
        this.doc = new Model.Doc();
        this.doc.project = project;
        this.doc.root = root.toAbsolutePath().toString();
        this.doc.extractedAt = java.time.Instant.now().toString();
    }

    public Model.Doc run() throws IOException {
        List<Path> sourceRoots = findSourceRoots();
        if (sourceRoots.isEmpty()) {
            doc.warnings.add("no src/main/java directories found under " + root);
        }

        CombinedTypeSolver solver = new CombinedTypeSolver(new ReflectionTypeSolver());
        for (Path sr : sourceRoots) solver.add(new JavaParserTypeSolver(sr));
        ParserConfiguration config = new ParserConfiguration()
                .setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_21)
                .setSymbolResolver(new JavaSymbolSolver(solver));
        JavaParser parser = new JavaParser(config);

        String appId = "java:application:" + doc.project;
        Model.Node app = new Model.Node(appId, "Application", "application:" + doc.project,
                doc.project, "", 0, 0, "");
        doc.addNode(app);

        // pass 1: parse everything, register files and types
        for (Path sr : sourceRoots) {
            try (Stream<Path> walk = Files.walk(sr)) {
                for (Path file : walk.filter(p -> p.toString().endsWith(".java")).sorted().toList()) {
                    parseFile(parser, file, appId);
                }
            }
        }

        // pass 2: extraction that needs the full type registry
        for (Parsed p : parsed) {
            try {
                extractFromUnit(p);
            } catch (Exception e) {
                doc.warnings.add("extraction failed for " + p.relPath + ": " + e);
            }
        }

        doc.pruneDanglingEdges();
        return doc;
    }

    private List<Path> findSourceRoots() throws IOException {
        try (Stream<Path> walk = Files.walk(root)) {
            return walk.filter(Files::isDirectory)
                    .filter(p -> p.endsWith(Path.of("src", "main", "java")))
                    .filter(p -> !p.toString().contains("/target/") && !p.toString().contains("/build/"))
                    .sorted()
                    .toList();
        }
    }

    private void parseFile(JavaParser parser, Path file, String appId) {
        String relPath = root.relativize(file).toString();
        try {
            CompilationUnit cu = parser.parse(file).getResult().orElse(null);
            if (cu == null) {
                doc.warnings.add("unparseable: " + relPath);
                return;
            }
            String content = Files.readString(file);
            String fileId = "java:" + relPath;
            doc.addNode(new Model.Node(fileId, "File", relPath, file.getFileName().toString(),
                    relPath, 1, (int) content.lines().count(), Model.sha256(content)));
            doc.addEdge(appId, fileId, "DECLARES");
            parsed.add(new Parsed(cu, file, relPath));

            for (TypeDeclaration<?> td : cu.findAll(TypeDeclaration.class)) {
                if (td instanceof AnnotationDeclaration) continue;
                String fqn = td.getFullyQualifiedName().map(Object::toString).orElse(null);
                if (fqn == null) continue;
                String label = classify(td);
                projectTypes.put(fqn, new TypeInfo(fqn, label, fileId, td));
                simpleToFqn.putIfAbsent(td.getNameAsString(), fqn);
            }
        } catch (Exception e) {
            doc.warnings.add("parse error in " + relPath + ": " + e.getMessage());
        }
    }

    private String classify(TypeDeclaration<?> td) {
        if (hasAnnotation(td, CONTROLLER_ANN)) return "Controller";
        if (hasAnnotation(td, Set.of("Repository")) || extendsRepository(td)) return "Repository";
        if (hasAnnotation(td, Set.of("Entity"))) return "Entity";
        if (hasAnnotation(td, SERVICE_ANN)) return "Service";
        return "Class";
    }

    private boolean extendsRepository(TypeDeclaration<?> td) {
        if (!(td instanceof ClassOrInterfaceDeclaration cid) || !cid.isInterface()) return false;
        return cid.getExtendedTypes().stream()
                .anyMatch(t -> REPO_INTERFACES.contains(t.getNameAsString()));
    }

    // ---------------------------------------------------------------- pass 2

    private void extractFromUnit(Parsed p) {
        for (TypeDeclaration<?> td : p.cu.findAll(TypeDeclaration.class)) {
            if (td instanceof AnnotationDeclaration) continue;
            String fqn = td.getFullyQualifiedName().map(Object::toString).orElse(null);
            if (fqn == null) continue;
            TypeInfo info = projectTypes.get(fqn);
            if (info == null) continue;

            Model.Node typeNode = typeNode(info, p.relPath);
            doc.addNode(typeNode);
            doc.addEdge(info.fileId(), typeNode.id, "DECLARES");

            extractMethods(td, fqn, typeNode);
            extractHierarchy(td, typeNode);
            extractInjection(td, typeNode);

            switch (info.label()) {
                case "Entity" -> extractEntity(td, typeNode);
                case "Repository" -> extractRepository(td, typeNode);
                case "Controller" -> extractController(td, fqn, typeNode, p.relPath);
                default -> {}
            }
        }
        extractImports(p);
    }

    private Model.Node typeNode(TypeInfo info, String relPath) {
        TypeDeclaration<?> td = info.decl();
        Model.Node n = new Model.Node("java:" + info.fqn(), info.label(), info.fqn(),
                td.getNameAsString(), relPath,
                td.getRange().map(r -> r.begin.line).orElse(0),
                td.getRange().map(r -> r.end.line).orElse(0),
                Model.sha256(td.toString()));
        List<String> fields = new ArrayList<>();
        for (FieldDeclaration fd : td.getFields()) {
            for (VariableDeclarator v : fd.getVariables()) {
                fields.add(v.getNameAsString() + ":" + v.getTypeAsString());
            }
        }
        if (td instanceof RecordDeclaration rd) {
            rd.getParameters().forEach(param ->
                    fields.add(param.getNameAsString() + ":" + param.getTypeAsString()));
        }
        if (!fields.isEmpty()) n.props.put("fields", fields);
        return n;
    }

    // ------------------------------------------------------------- methods + calls

    private void extractMethods(TypeDeclaration<?> td, String typeFqn, Model.Node typeNode) {
        boolean classTransactional = hasAnnotation(td, Set.of("Transactional"));
        for (MethodDeclaration md : td.getMethods()) {
            String methodId = methodId(md, typeFqn);
            Model.Node mn = new Model.Node(methodId, "Method",
                    methodId.substring("java:".length()), md.getNameAsString(),
                    typeNode.filePath,
                    md.getRange().map(r -> r.begin.line).orElse(0),
                    md.getRange().map(r -> r.end.line).orElse(0),
                    Model.sha256(md.toString()));
            mn.props.put("signature", md.getSignature().asString());
            mn.props.put("returnType", md.getTypeAsString());
            mn.props.put("params", md.getParameters().stream()
                    .map(pp -> pp.getNameAsString() + ":" + pp.getTypeAsString()).toList());
            mn.props.put("visibility", md.getAccessSpecifier().asString());
            extractProcessSemantics(md, mn, classTransactional, typeNode);
            doc.addNode(mn);
            doc.addEdge(typeNode.id, methodId, "DECLARES");
            extractCalls(md, methodId);
            extractPublishes(md, mn.id, td);
        }
    }

    /** Process-view: concurrency/transaction flags and message consumption. */
    private void extractProcessSemantics(MethodDeclaration md, Model.Node mn,
                                         boolean classTransactional, Model.Node typeNode) {
        if (hasAnnotation(md, Set.of("Async"))) mn.props.put("async", true);
        if (classTransactional || hasAnnotation(md, Set.of("Transactional"))) {
            mn.props.put("transactional", true);
        }
        md.getAnnotationByName("Scheduled").ifPresent(a -> {
            String spec = "true";
            if (a instanceof NormalAnnotationExpr na) {
                spec = na.getPairs().stream()
                        .map(pr -> pr.getNameAsString() + "=" + pr.getValue().toString().replace("\"", ""))
                        .collect(Collectors.joining(","));
            }
            mn.props.put("scheduled", spec);
        });
        for (String listener : List.of("KafkaListener", "RabbitListener", "JmsListener")) {
            Optional<AnnotationExpr> ann = md.getAnnotationByName(listener);
            if (ann.isEmpty()) continue;
            String topicName = listenerTopic(ann.get());
            if (topicName == null) topicName = md.getNameAsString();
            String topicId = topicNode(topicName, listener.replace("Listener", "").toLowerCase());
            Model.Edge e = doc.addEdge(topicId, mn.id, "CONSUMES_FROM");
            if (e != null) e.props.put("via", listener);
        }
    }

    private String listenerTopic(AnnotationExpr a) {
        if (a instanceof SingleMemberAnnotationExpr sm) return firstString(sm.getMemberValue()).orElse(null);
        if (a instanceof NormalAnnotationExpr na) {
            for (var pair : na.getPairs()) {
                String n = pair.getNameAsString();
                if (n.equals("topics") || n.equals("queues") || n.equals("destination") || n.equals("value")) {
                    return firstString(pair.getValue()).orElse(null);
                }
            }
        }
        return null;
    }

    /** PUBLISHES_TO: <messagingTemplateField>.send/convertAndSend("topic", ...) calls. */
    private void extractPublishes(MethodDeclaration md, String methodId, TypeDeclaration<?> td) {
        Set<String> templateFields = new HashSet<>();
        for (FieldDeclaration fd : td.getFields()) {
            String typeName = fd.getElementType().asString();
            if (typeName.contains("KafkaTemplate") || typeName.contains("RabbitTemplate")
                    || typeName.contains("JmsTemplate") || typeName.contains("StreamBridge")) {
                fd.getVariables().forEach(v -> templateFields.add(v.getNameAsString()));
            }
        }
        if (templateFields.isEmpty()) return;
        for (MethodCallExpr call : md.findAll(MethodCallExpr.class)) {
            String name = call.getNameAsString();
            if (!name.equals("send") && !name.equals("convertAndSend")) continue;
            String scope = call.getScope().map(s -> s.toString().replace("this.", "")).orElse("");
            if (!templateFields.contains(scope)) continue;
            if (call.getArguments().isEmpty()) continue;
            Optional<String> topicName = firstString(call.getArgument(0));
            if (topicName.isEmpty()) continue;
            String topicId = topicNode(topicName.get(), "queue");
            doc.addEdge(methodId, topicId, "PUBLISHES_TO");
        }
    }

    private String topicNode(String name, String kind) {
        String id = "java:topic:" + name;
        Model.Node t = new Model.Node(id, "Topic", "topic:" + name, name, "", 0, 0,
                Model.sha256("topic:" + name));
        t.props.put("kind", kind);
        doc.addNode(t);
        return id;
    }

    /** Stable method id; prefers resolved qualified signature so CALLS targets line up. */
    private String methodId(MethodDeclaration md, String typeFqn) {
        try {
            ResolvedMethodDeclaration r = md.resolve();
            return "java:" + r.declaringType().getQualifiedName() + "#" + r.getSignature();
        } catch (Throwable t) {
            return "java:" + typeFqn + "#" + md.getSignature().asString();
        }
    }

    private void extractCalls(MethodDeclaration md, String callerId) {
        for (MethodCallExpr call : md.findAll(MethodCallExpr.class)) {
            try {
                ResolvedMethodDeclaration r = call.resolve();
                String declType = r.declaringType().getQualifiedName();
                if (!projectTypes.containsKey(declType)) continue;
                String targetId = "java:" + declType + "#" + r.getSignature();
                Model.Edge e = doc.addEdge(callerId, targetId, "CALLS");
                if (e != null) {
                    call.getRange().ifPresent(range -> e.props.put("line", range.begin.line));
                }
            } catch (Throwable ignored) {
                // unresolvable (third-party, lambdas, generics edge cases) — skip silently
            }
        }
    }

    // ------------------------------------------------------------- hierarchy + DI

    private void extractHierarchy(TypeDeclaration<?> td, Model.Node typeNode) {
        if (!(td instanceof ClassOrInterfaceDeclaration cid)) return;
        for (ClassOrInterfaceType t : cid.getExtendedTypes()) {
            String target = resolveProjectType(t.getNameAsString());
            if (target != null) doc.addEdge(typeNode.id, "java:" + target, "EXTENDS");
        }
        for (ClassOrInterfaceType t : cid.getImplementedTypes()) {
            String target = resolveProjectType(t.getNameAsString());
            if (target != null) doc.addEdge(typeNode.id, "java:" + target, "IMPLEMENTS");
        }
    }

    private void extractInjection(TypeDeclaration<?> td, Model.Node typeNode) {
        for (ConstructorDeclaration cd : td.getConstructors()) {
            for (Parameter param : cd.getParameters()) {
                String target = resolveProjectType(baseTypeName(param.getType()));
                if (target != null && !("java:" + target).equals(typeNode.id)) {
                    Model.Edge e = doc.addEdge(typeNode.id, "java:" + target, "INJECTS");
                    if (e != null) e.props.put("via", param.getNameAsString());
                }
            }
        }
        for (FieldDeclaration fd : td.getFields()) {
            if (!hasAnnotation(fd, Set.of("Autowired", "Inject"))) continue;
            String target = resolveProjectType(baseTypeName(fd.getElementType()));
            if (target != null) {
                Model.Edge e = doc.addEdge(typeNode.id, "java:" + target, "INJECTS");
                if (e != null && !fd.getVariables().isEmpty()) {
                    e.props.put("via", fd.getVariable(0).getNameAsString());
                }
            }
        }
    }

    // ------------------------------------------------------------- JPA

    private void extractEntity(TypeDeclaration<?> td, Model.Node entityNode) {
        String tableName = annotationValue(td, "Table", "name")
                .orElse(Model.snakeCase(td.getNameAsString()));
        entityNode.props.put("tableName", tableName);

        String tableId = "java:table:" + tableName;
        List<String> columns = new ArrayList<>();
        for (FieldDeclaration fd : td.getFields()) {
            if (fd.isStatic() || hasAnnotation(fd, Set.of("Transient"))) continue;
            if (hasAnnotation(fd, RELATION_ANN)) {
                extractRelation(fd, entityNode);
                // ManyToOne/OneToOne owning side still has a join column in this table
                annotationValue(fd, "JoinColumn", "name").ifPresent(columns::add);
                continue;
            }
            String col = annotationValue(fd, "Column", "name")
                    .orElse(Model.snakeCase(fd.getVariable(0).getNameAsString()));
            columns.add(col);
        }
        Model.Node table = new Model.Node(tableId, "Table", "table:" + tableName, tableName,
                "", 0, 0, Model.sha256(tableName + columns));
        table.props.put("tableName", tableName);
        table.props.put("columns", columns);
        doc.addNode(table);
        doc.addEdge(entityNode.id, tableId, "MAPS_TO");
    }

    private void extractRelation(FieldDeclaration fd, Model.Node entityNode) {
        String kind = RELATION_ANN.stream()
                .filter(a -> hasAnnotation(fd, Set.of(a))).findFirst().orElse("");
        String targetSimple = baseTypeName(fd.getElementType());
        String target = resolveProjectType(targetSimple);
        if (target != null) {
            Model.Edge e = doc.addEdge(entityNode.id, "java:" + target, "RELATES_TO");
            if (e != null) {
                e.props.put("kind", kind);
                e.props.put("field", fd.getVariable(0).getNameAsString());
            }
        }
    }

    private void extractRepository(TypeDeclaration<?> td, Model.Node repoNode) {
        if (!(td instanceof ClassOrInterfaceDeclaration cid)) return;
        String entityFqn = null;
        for (ClassOrInterfaceType ext : cid.getExtendedTypes()) {
            if (!REPO_INTERFACES.contains(ext.getNameAsString())) continue;
            var args = ext.getTypeArguments().orElse(null);
            if (args != null && !args.isEmpty()) {
                entityFqn = resolveProjectType(baseTypeName(args.get(0)));
                if (args.size() > 1) repoNode.props.put("idType", args.get(1).asString());
            }
        }
        if (entityFqn == null) return;
        repoNode.props.put("entityFqn", entityFqn);
        String entityId = "java:" + entityFqn;
        doc.addEdge(repoNode.id, entityId, "MANAGES");

        boolean reads = false;
        boolean writes = false;
        for (MethodDeclaration md : cid.getMethods()) {
            String name = md.getNameAsString();
            boolean modifying = hasAnnotation(md, Set.of("Modifying"));
            if (modifying || name.startsWith("save") || name.startsWith("delete")
                    || name.startsWith("update") || name.startsWith("insert")) {
                writes = true;
            } else if (name.startsWith("find") || name.startsWith("get") || name.startsWith("read")
                    || name.startsWith("count") || name.startsWith("exists")
                    || name.startsWith("search") || hasAnnotation(md, Set.of("Query"))) {
                reads = true;
            }
        }
        if (reads) doc.addEdge(repoNode.id, entityId, "READS");
        if (writes) doc.addEdge(repoNode.id, entityId, "WRITES");
    }

    // ------------------------------------------------------------- Spring MVC

    private void extractController(TypeDeclaration<?> td, String fqn, Model.Node ctrlNode,
                                   String relPath) {
        String basePath = annotationFirstPath(td, "RequestMapping").orElse("");
        for (MethodDeclaration md : td.getMethods()) {
            String verb = null;
            String methodPath = null;
            for (Map.Entry<String, String> entry : MAPPING_ANN.entrySet()) {
                if (md.getAnnotationByName(entry.getKey()).isPresent()) {
                    verb = entry.getValue();
                    methodPath = annotationFirstPath(md, entry.getKey()).orElse("");
                    break;
                }
            }
            if (verb == null && md.getAnnotationByName("RequestMapping").isPresent()) {
                verb = requestMappingVerb(md).orElse("ANY");
                methodPath = annotationFirstPath(md, "RequestMapping").orElse("");
            }
            if (verb == null) continue;

            String path = joinPaths(basePath, methodPath);
            String endpointId = "java:" + fqn + "#" + md.getNameAsString() + ":" + verb + " " + path;
            Model.Node ep = new Model.Node(endpointId, "Endpoint",
                    endpointId.substring("java:".length()),
                    verb + " " + path, relPath,
                    md.getRange().map(r -> r.begin.line).orElse(0),
                    md.getRange().map(r -> r.end.line).orElse(0),
                    Model.sha256(md.toString()));
            ep.props.put("httpMethod", verb);
            ep.props.put("path", path);
            ep.props.put("normalizedPath", normalizePath(path));

            // request DTO: @RequestBody parameter
            String requestType = "";
            for (Parameter param : md.getParameters()) {
                if (hasAnnotation(param, Set.of("RequestBody"))) {
                    requestType = registerDtoAndLink(param.getType(), endpointId, "ACCEPTS");
                }
            }
            String responseType = registerDtoAndLink(md.getType(), endpointId, "RETURNS");
            ep.props.put("requestType", requestType);
            ep.props.put("responseType", responseType);

            doc.addNode(ep);
            doc.addEdge(ctrlNode.id, endpointId, "EXPOSES");
            doc.addEdge(endpointId, methodId(md, fqn), "HANDLED_BY");
        }
    }

    /** Unwrap generics (ResponseEntity/List/Page/Optional/...) to project types; link + label DTO. */
    private String registerDtoAndLink(Type type, String endpointId, String edgeType) {
        List<String> found = new ArrayList<>();
        collectProjectTypes(type, found);
        for (String dtoFqn : found) {
            TypeInfo info = projectTypes.get(dtoFqn);
            if (info != null && info.label().equals("Class")) {
                projectTypes.put(dtoFqn, new TypeInfo(dtoFqn, "DTO", info.fileId(), info.decl()));
                Model.Node existing = doc.nodeIndex.get("java:" + dtoFqn);
                if (existing != null) existing.label = "DTO";
            }
            doc.addEdge(endpointId, "java:" + dtoFqn, edgeType);
        }
        return found.isEmpty() ? "" : found.get(0);
    }

    private void collectProjectTypes(Type type, List<String> out) {
        if (type == null) return;
        if (type.isClassOrInterfaceType()) {
            ClassOrInterfaceType cit = type.asClassOrInterfaceType();
            String resolved = resolveProjectType(cit.getNameAsString());
            if (resolved != null && !out.contains(resolved)) out.add(resolved);
            cit.getTypeArguments().ifPresent(args -> args.forEach(a -> collectProjectTypes(a, out)));
        }
    }

    private void extractImports(Parsed p) {
        String fileId = "java:" + p.relPath;
        for (var imp : p.cu.getImports()) {
            if (imp.isAsterisk()) continue;
            String name = imp.getNameAsString();
            TypeInfo target = projectTypes.get(name);
            if (target != null && !target.fileId().equals(fileId)) {
                doc.addEdge(fileId, target.fileId(), "IMPORTS");
            }
        }
    }

    // ------------------------------------------------------------- helpers

    private String resolveProjectType(String simpleName) {
        if (simpleName == null) return null;
        String fqn = simpleToFqn.get(simpleName);
        return fqn != null && projectTypes.containsKey(fqn) ? fqn : null;
    }

    /** List&lt;Order&gt; -> Order, Optional&lt;Customer&gt; -> Customer, Order -> Order. */
    private String baseTypeName(Type type) {
        if (type == null) return null;
        if (type.isClassOrInterfaceType()) {
            ClassOrInterfaceType cit = type.asClassOrInterfaceType();
            var args = cit.getTypeArguments().orElse(null);
            if (args != null && !args.isEmpty()
                    && Set.of("List", "Set", "Collection", "Optional", "Page", "Iterable")
                            .contains(cit.getNameAsString())) {
                return baseTypeName(args.get(0));
            }
            return cit.getNameAsString();
        }
        return type.asString();
    }

    private boolean hasAnnotation(NodeWithAnnotations<?> node, Set<String> names) {
        return node.getAnnotations().stream()
                .anyMatch(a -> names.contains(a.getName().getIdentifier()));
    }

    /** First path string of @Ann(value/path = "..." | {"...", ...} ) or @Ann("..."). */
    private Optional<String> annotationFirstPath(NodeWithAnnotations<?> node, String annName) {
        Optional<AnnotationExpr> ann = node.getAnnotationByName(annName);
        if (ann.isEmpty()) return Optional.empty();
        AnnotationExpr a = ann.get();
        if (a instanceof SingleMemberAnnotationExpr sm) {
            return firstString(sm.getMemberValue());
        }
        if (a instanceof NormalAnnotationExpr na) {
            for (var pair : na.getPairs()) {
                if (pair.getNameAsString().equals("value") || pair.getNameAsString().equals("path")) {
                    return firstString(pair.getValue());
                }
            }
        }
        return Optional.of("");
    }

    private Optional<String> annotationValue(NodeWithAnnotations<?> node, String annName, String member) {
        Optional<AnnotationExpr> ann = node.getAnnotationByName(annName);
        if (ann.isEmpty()) return Optional.empty();
        if (ann.get() instanceof NormalAnnotationExpr na) {
            for (var pair : na.getPairs()) {
                if (pair.getNameAsString().equals(member)) return firstString(pair.getValue());
            }
        }
        return Optional.empty();
    }

    private Optional<String> firstString(Expression expr) {
        if (expr instanceof StringLiteralExpr s) return Optional.of(s.asString());
        if (expr instanceof ArrayInitializerExpr arr && !arr.getValues().isEmpty()) {
            return firstString(arr.getValues().get(0));
        }
        return Optional.empty();
    }

    private Optional<String> requestMappingVerb(MethodDeclaration md) {
        Optional<AnnotationExpr> ann = md.getAnnotationByName("RequestMapping");
        if (ann.isPresent() && ann.get() instanceof NormalAnnotationExpr na) {
            for (var pair : na.getPairs()) {
                if (pair.getNameAsString().equals("method")) {
                    String text = pair.getValue().toString();
                    for (String verb : List.of("GET", "POST", "PUT", "DELETE", "PATCH")) {
                        if (text.contains(verb)) return Optional.of(verb);
                    }
                }
            }
        }
        return Optional.empty();
    }

    static String joinPaths(String base, String method) {
        String joined = ("/" + (base == null ? "" : base) + "/" + (method == null ? "" : method))
                .replaceAll("/{2,}", "/");
        if (joined.length() > 1 && joined.endsWith("/")) joined = joined.substring(0, joined.length() - 1);
        return joined;
    }

    static String normalizePath(String path) {
        return Arrays.stream(path.split("/"))
                .map(seg -> seg.matches("\\{[^}]*\\}") ? "{*}" : seg.toLowerCase())
                .collect(Collectors.joining("/"));
    }
}
