// Issue #336: a model whose string indexer is `unknown` (`...Record<unknown>`,
// `is Record<unknown>`, or inherited from a passthrough base) must keep every
// undeclared key on load and write it back on save. Each runtime gets a public
// `additionalProperties` member (idiomatically cased); known keys are matched by
// wire name (`@encodedName`), include inherited fields and the discriminator, and
// always win over a same-named extras entry on save.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import * as ts from "typescript";

const require = createRequire(import.meta.url);

const TARGETS: Array<[type: string, dir: string, native?: string]> = [
  ["TypeScript", "typescript"],
  ["TypeScript", "typescript-zod", "zod"],
  ["Python", "python"],
  ["Python", "python-pydantic", "pydantic"],
  ["Go", "go"],
  ["Java", "java"],
  ["Java", "java-jackson", "jackson"],
  ["CSharp", "csharp"],
  ["Rust", "rust"],
  ["Rust", "rust-serde", "serde"],
  ["Swift", "swift"],
  ["Swift", "swift-codable", "codable"],
];

function tspCli(): string {
  const compilerEntry = require.resolve("@typespec/compiler");
  const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
  return path.join(compilerRoot, "cmd", "tsp.js");
}

function compile(root: string, source: string, rootObject: string): string {
  const config = path.join(root, "tspconfig.yaml");
  const lines = [
    "emit:",
    '  - "@typra/emitter"',
    "options:",
    '  "@typra/emitter":',
    `    emitter-output-dir: ${JSON.stringify(path.join(root, "generated"))}`,
    `    root-object: ${JSON.stringify(rootObject)}`,
    "    deterministic-output: true",
    "    emit-targets:",
  ];
  for (const [type, dir, native] of TARGETS) {
    lines.push(`      - type: ${type}`);
    lines.push(
      `        output-dir: ${JSON.stringify(path.join(root, "generated", dir))}`,
    );
    lines.push(
      `        test-dir: ${JSON.stringify(path.join(root, "generated", dir, "tests"))}`,
    );
    lines.push("        format: false");
    if (native) lines.push(`        native-serialization: ${native}`);
  }
  writeFileSync(config, [...lines, ""].join("\n"));
  const result = spawnSync(
    process.execPath,
    [tspCli(), "compile", source, "--config", config],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  return `${result.stdout}${result.stderr}`;
}

function readTree(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else
        files.set(
          path.relative(dir, full).split(path.sep).join("/"),
          readFileSync(full, "utf8"),
        );
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

function pick(files: Map<string, string>, pattern: RegExp): string {
  const matches = [...files.entries()].filter(
    ([name]) => !name.startsWith("tests/") && pattern.test(name),
  );
  assert.ok(
    matches.length > 0,
    `no generated file matches ${pattern}: ${[...files.keys()].join(", ")}`,
  );
  return matches.map(([, content]) => content).join("\n");
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const has = (source: string, snippet: string, label: string) =>
  assert.match(source, new RegExp(escape(snippet)), label);
const lacks = (source: string, pattern: RegExp, label: string) =>
  assert.doesNotMatch(source, pattern, label);

describe("unknown-field passthrough emission (#336)", () => {
  const fixture = path.resolve(
    process.cwd(),
    "fixtures",
    "features",
    "additional-properties",
    "main.tsp",
  );
  let root = "";
  let output = "";
  const generated = new Map<string, Map<string, string>>();

  before(() => {
    root = mkdtempSync(path.join(process.cwd(), "tmp-additional-props-emit-"));
    output = compile(
      root,
      fixture,
      "Typra.Fixtures.Features.AdditionalProperties.Root",
    );
    for (const [, dir] of TARGETS) {
      generated.set(dir, readTree(path.join(root, "generated", dir)));
    }
  });

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const file = (dir: string, pattern: RegExp) =>
    pick(generated.get(dir)!, pattern);

  it("compiles every passthrough shape without diagnostics", () => {
    assert.match(output, /Compilation completed successfully/, output);
    assert.doesNotMatch(
      output,
      /unsupported-additional-properties|additional-properties-collision|error/i,
      output,
    );
  });

  it("TypeScript keeps extras, captures unknown keys, and writes them after known fields", () => {
    for (const dir of ["typescript", "typescript-zod"]) {
      const row = file(dir, /(^|\/)row\.ts$/);
      has(row, "additionalProperties: Record<string, unknown> = Object.create(null);", dir);
      has(row, 'case "time":\n      case "started_at":\n        return true;', dir);
      has(row, "if (!instance.isKnownWireKey(key)) {", dir);
      has(row, "instance.additionalProperties[key] = value;", dir);
      has(row, "const extras = obj.additionalProperties ?? {};", dir);
      has(row, "for (const [key, value] of Object.entries(extras)) {", dir);
      has(row, "if (!obj.isKnownWireKey(key)) {", dir);
      has(file(dir, /(^|\/)bag\.ts$/), 'case "label":\n        return true;', dir);
      const event = file(dir, /(^|\/)event\.ts$/);
      has(event, 'case "kind":\n      case "event_id":\n        return true;', dir);
      // The derived variant's known keys include inherited fields and the discriminator.
      has(event, 'case "kind":\n      case "x":\n      case "event_id":\n        return true;', dir);
      lacks(file(dir, /(^|\/)plain\.ts$/), /additionalProperties|isKnownWireKey/, dir);
    }
    assert.match(file("typescript-zod", /(^|\/)row\.ts$/), /\}\)\.passthrough\(\)/);
    assert.match(
      file("typescript-zod", /(^|\/)row\.ts$/),
      /z\.lazy\(\(\) =>\s+typraKeepProtoKey\(Row\.wireObjectSchema\)/,
    );
    // The helper is emitted once per file, even when it holds several passthrough models.
    assert.equal(
      file("typescript-zod", /(^|\/)event\.ts$/).match(/function typraKeepProtoKey\(/g)?.length,
      1,
    );
    lacks(file("typescript", /(^|\/)row\.ts$/), /typraKeepProtoKey/, "typescript");
  });

  it("TypeScript preserves an unknown `__proto__` key without touching prototypes", () => {
    for (const dir of ["typescript", "typescript-zod"]) {
      const runtime = path.join(root, "runtime", dir);
      for (const [name, source] of generated.get(dir)!) {
        if (name.startsWith("tests/") || !name.endsWith(".ts")) continue;
        const target = path.join(runtime, name.replace(/\.ts$/, ".js"));
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(
          target,
          ts.transpileModule(source, {
            compilerOptions: {
              module: ts.ModuleKind.CommonJS,
              target: ts.ScriptTarget.ES2020,
              esModuleInterop: true,
            },
          }).outputText,
        );
      }
      writeFileSync(path.join(runtime, "package.json"), '{"type":"commonjs"}\n');
      const script = [
        "const { Row } = require('./row.js');",
        `const data = JSON.parse('{"time":"t","__proto__":{"polluted":1},"other":2}');`,
        "const row = Row.load(data);",
        "const saved = row.save();",
        "const extrasProto = Object.getPrototypeOf(row.additionalProperties);",
        "console.log(JSON.stringify({",
        "  rowIsRow: Object.getPrototypeOf(row) === Row.prototype,",
        "  extrasOwn: Object.prototype.hasOwnProperty.call(row.additionalProperties, '__proto__'),",
        "  extrasProtoClean: extrasProto === null,",
        "  savedProtoIsObject: Object.getPrototypeOf(saved) === Object.prototype,",
        "  globalClean: ({}).polluted === undefined,",
        "  json: JSON.stringify(saved),",
        "  yaml: Row.fromYaml('time: t\\n__proto__:\\n  polluted: 1\\n').toYaml(),",
        "  zod: Row.schema ? JSON.stringify(Row.schema.parse(data)) : null,",
        "}));",
      ].join("\n");
      writeFileSync(path.join(runtime, "probe.js"), script);
      const result = spawnSync(process.execPath, ["probe.js"], {
        cwd: runtime,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, `${dir}: ${result.stdout}${result.stderr}`);
      const probe = JSON.parse(result.stdout.trim().split("\n").pop()!);
      assert.equal(probe.rowIsRow, true, dir);
      assert.equal(probe.extrasOwn, true, `${dir}: __proto__ not captured as an own key`);
      assert.equal(probe.extrasProtoClean, true, dir);
      assert.equal(probe.savedProtoIsObject, true, dir);
      assert.equal(probe.globalClean, true, dir);
      assert.deepEqual(
        JSON.parse(probe.json),
        JSON.parse('{"time":"t","__proto__":{"polluted":1},"other":2}'),
        dir,
      );
      assert.match(probe.json, /"__proto__":\{"polluted":1\}/, dir);
      assert.match(probe.yaml, /__proto__:\s+polluted: 1/, `${dir}: ${probe.yaml}`);
      if (dir === "typescript-zod") {
        assert.match(probe.zod, /"__proto__":\{"polluted":1\}/, `${dir}: ${probe.zod}`);
      }
    }
  });

  it("Python keeps extras, captures unknown keys, and writes them after known fields", () => {
    for (const dir of ["python", "python-pydantic"]) {
      const factory =
        dir === "python" ? "field(default_factory=dict)" : "Field(default_factory=dict)";
      const row = file(dir, /(^|\/)_Row\.py$/);
      has(row, `additional_properties: dict[str, Any] = ${factory}`, dir);
      has(
        row,
        '_known_wire_keys: ClassVar[frozenset[str]] = frozenset({"time", "started_at"})',
        dir,
      );
      has(row, "instance.additional_properties = {", dir);
      has(row, "if key not in instance._known_wire_keys", dir);
      has(row, "for key, value in (obj.additional_properties or {}).items():", dir);
      has(row, "if key not in obj._known_wire_keys:", dir);
      const event = file(dir, /(^|\/)_Event\.py$/);
      has(event, 'frozenset({"kind", "event_id"})', dir);
      has(event, 'frozenset({"kind", "x", "event_id"})', dir);
      // The derived class inherits the member instead of redeclaring it.
      assert.equal(
        event.match(/additional_properties: dict\[str, Any\]/g)?.length,
        1,
        dir,
      );
      lacks(file(dir, /(^|\/)_Plain\.py$/), /additional_properties|_known_wire_keys/, dir);
    }
  });

  it("Go keeps extras out of struct tags and guards known wire keys on load and save", () => {
    const row = file("go", /(^|\/)row\.go$/);
    has(row, 'AdditionalProperties map[string]interface{} `json:"-" yaml:"-"`', "go");
    has(row, "result.AdditionalProperties = make(map[string]interface{})", "go");
    has(row, "result.AdditionalProperties[key] = value", "go");
    has(row, "for key, value := range obj.AdditionalProperties {", "go");
    assert.equal(row.match(/case "time", "started_at":\s+continue/g)?.length, 2);
    const event = file("go", /(^|\/)event\.go$/);
    assert.match(event, /case "kind", "x", "event_id":\s+continue/);
    lacks(file("go", /(^|\/)plain\.go$/), /AdditionalProperties/, "go");
  });

  it("C# keeps extras, captures unknown keys, and writes them after known fields", () => {
    const row = file("csharp", /(^|\/)Row\.cs$/);
    has(row, "public Dictionary<string, object?> AdditionalProperties { get; set; } = new();", "cs");
    has(row, 'protected virtual bool IsKnownWireKey(string key) => key is "time" or "started_at";', "cs");
    has(row, "if (!instance.IsKnownWireKey(entry.Key))", "cs");
    has(row, "instance.AdditionalProperties[entry.Key] = entry.Value;", "cs");
    has(row, "foreach (var entry in obj.AdditionalProperties ?? new())", "cs");
    has(row, "if (!obj.IsKnownWireKey(entry.Key))", "cs");
    const click = file("csharp", /(^|\/)ClickEvent\.cs$/);
    assert.match(
      click,
      /protected override bool IsKnownWireKey\(string key\) => key is "kind" or "x" or "event_id";/,
    );
    lacks(click, /public Dictionary<string, object\?> AdditionalProperties/, "cs");
    lacks(file("csharp", /(^|\/)Plain\.cs$/), /AdditionalProperties \{|IsKnownWireKey/, "cs");
  });

  it("Java keeps extras, captures unknown keys, and writes them after known fields", () => {
    for (const dir of ["java", "java-jackson"]) {
      const row = file(dir, /(^|\/)Row\.java$/);
      has(row, "public Map<String, Object> additionalProperties = new LinkedHashMap<>();", dir);
      has(
        row,
        'return switch (key) { case "time", "started_at" -> true; default -> false; };',
        dir,
      );
      has(row, "if (!result.isKnownWireKey(key)) {", dir);
      has(row, "result.additionalProperties.put(key, entry.getValue());", dir);
      has(
        row,
        "if (!obj.isKnownWireKey(entry.getKey())) result.put(entry.getKey(), entry.getValue());",
        dir,
      );
      const click = file(dir, /(^|\/)ClickEvent\.java$/);
      has(click, 'case "kind", "x", "event_id" -> true;', dir);
      assert.match(click, /@Override\s+protected boolean isKnownWireKey\(String key\)/, dir);
      lacks(file(dir, /(^|\/)Plain\.java$/), /additionalProperties|isKnownWireKey/, dir);
    }
    // Jackson must not serialize the extras map as a nested property.
    assert.match(
      file("java-jackson", /(^|\/)Row\.java$/),
      /@JsonIgnore\s+public Map<String, Object> additionalProperties/,
    );
  });

  it("Rust keeps extras in a JSON map and filters known wire keys per discriminator", () => {
    for (const dir of ["rust", "rust-serde"]) {
      const row = file(dir, /(^|\/)row\.rs$/);
      has(row, "pub additional_properties: serde_json::Map<String, serde_json::Value>,", dir);
      has(row, 'additional_properties: Self::capture_additional_properties(&value, ""),', dir);
      has(row, 'matches!(key, "time" | "started_at")', dir);
      has(row, "for (key, value) in &self.additional_properties {", dir);
      has(row, 'if Self::additional_properties_known_key("", key) {', dir);
      const event = file(dir, /(^|\/)event\.rs$/);
      has(event, 'matches!(key, "kind" | "event_id")', dir);
      has(event, '"click" => matches!(key, "kind" | "x" | "event_id"),', dir);
      lacks(file(dir, /(^|\/)plain\.rs$/), /additional_properties/, dir);
    }
  });

  it("Swift keeps extras, captures unknown keys, and writes them after known fields", () => {
    for (const dir of ["swift", "swift-codable"]) {
      const row = file(dir, /(^|\/)row\.swift$/);
      has(row, "public var additionalProperties: [String: Any] = [:]", dir);
      has(row, 'static let additionalPropertiesKnownKeys: Set<String> = ["time", "started_at"]', dir);
      has(row, "additionalProperties: [String: Any] = [:]) {", dir);
      has(
        row,
        "instance.additionalProperties = object.filter { !Self.additionalPropertiesKnownKeys.contains($0.key) }",
        dir,
      );
      has(
        row,
        "for (key, value) in self.additionalProperties where !Self.additionalPropertiesKnownKeys.contains(key) {",
        dir,
      );
      has(
        file(dir, /(^|\/)event\.swift$/),
        'static let additionalPropertiesKnownKeys: Set<String> = ["kind", "x", "event_id"]',
        dir,
      );
      lacks(file(dir, /(^|\/)plain\.swift$/), /additionalProperties/, dir);
    }
  });
});
