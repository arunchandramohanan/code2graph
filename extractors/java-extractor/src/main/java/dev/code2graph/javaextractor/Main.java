package dev.code2graph.javaextractor;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

public class Main {

    public static void main(String[] args) throws Exception {
        Map<String, String> opts = new HashMap<>();
        for (int i = 0; i + 1 < args.length; i += 2) {
            if (args[i].startsWith("--")) opts.put(args[i].substring(2), args[i + 1]);
        }
        String src = opts.get("src");
        String project = opts.get("project");
        String out = opts.get("out");
        if (src == null || project == null || out == null) {
            System.err.println("usage: java -jar java-extractor.jar --src <projectRoot> --project <name> --out <file.json>");
            System.exit(2);
        }
        Path root = Path.of(src);
        if (!Files.isDirectory(root)) {
            System.err.println("not a directory: " + src);
            System.exit(2);
        }

        Model.Doc doc = new Extractor(root, project).run();

        Gson gson = new GsonBuilder().disableHtmlEscaping().create();
        Files.writeString(Path.of(out), gson.toJson(doc));
        System.err.printf("java-extractor: %d nodes, %d edges, %d warnings -> %s%n",
                doc.nodes.size(), doc.edges.size(), doc.warnings.size(), out);
    }
}
