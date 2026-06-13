package dev.code2graph.javaextractor;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Output document model matching docs/CONTRACTS.md section 2. */
public class Model {

    public static class Node {
        public String id;
        public String label;
        public String fqn;
        public String name;
        public String filePath;
        public int startLine;
        public int endLine;
        public String hash;
        public Map<String, Object> props = new LinkedHashMap<>();

        public Node(String id, String label, String fqn, String name, String filePath,
                    int startLine, int endLine, String hash) {
            this.id = id;
            this.label = label;
            this.fqn = fqn;
            this.name = name;
            this.filePath = filePath;
            this.startLine = startLine;
            this.endLine = endLine;
            this.hash = hash;
        }
    }

    public static class Edge {
        public String source;
        public String target;
        public String type;
        public Map<String, Object> props = new LinkedHashMap<>();

        public Edge(String source, String target, String type) {
            this.source = source;
            this.target = target;
            this.type = type;
        }
    }

    public static class Doc {
        public String schemaVersion = "1.0";
        public String stack = "java";
        public String project;
        public String root;
        public String extractedAt;
        public List<Node> nodes = new ArrayList<>();
        public List<Edge> edges = new ArrayList<>();
        public List<String> warnings = new ArrayList<>();

        public transient Map<String, Node> nodeIndex = new LinkedHashMap<>();
        public transient Set<String> edgeKeys = new LinkedHashSet<>();

        public Node addNode(Node n) {
            Node existing = nodeIndex.get(n.id);
            if (existing != null) return existing;
            nodeIndex.put(n.id, n);
            nodes.add(n);
            return n;
        }

        public Edge addEdge(String source, String target, String type) {
            String key = source + "|" + type + "|" + target;
            if (!edgeKeys.add(key)) return null;
            Edge e = new Edge(source, target, type);
            edges.add(e);
            return e;
        }

        /** Drop edges whose endpoints are not in the node set (contract requirement). */
        public void pruneDanglingEdges() {
            List<Edge> kept = new ArrayList<>();
            for (Edge e : edges) {
                if (nodeIndex.containsKey(e.source) && nodeIndex.containsKey(e.target)) {
                    kept.add(e);
                } else {
                    warnings.add("dropped edge " + e.type + " " + e.source + " -> " + e.target);
                }
            }
            edges = kept;
        }
    }

    public static String sha256(String text) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : digest) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    public static String snakeCase(String s) {
        return s.replaceAll("([a-z0-9])([A-Z])", "$1_$2").toLowerCase();
    }
}
