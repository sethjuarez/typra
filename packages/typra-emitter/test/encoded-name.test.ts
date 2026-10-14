// Issue #337: `@encodedName("application/json", ...)` must drive the canonical wire
// key in every runtime's load and save paths, while the generated property keeps its
// idiomatic, TypeSpec-derived name.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

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

function compile(
  root: string,
  source: string,
  rootObject: string,
  targets: typeof TARGETS,
): string {
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
  for (const [type, dir, native] of targets) {
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
  const matches = [...files.entries()].filter(([name]) => pattern.test(name));
  assert.ok(
    matches.length > 0,
    `no generated file matches ${pattern}: ${[...files.keys()].join(", ")}`,
  );
  return matches.map(([, content]) => content).join("\n");
}

describe("@encodedName drives the canonical wire key (#337)", () => {
  const fixture = path.resolve(
    process.cwd(),
    "fixtures",
    "features",
    "encoded-name",
    "main.tsp",
  );
  let root = "";
  let output = "";
  const generated = new Map<string, Map<string, string>>();

  before(() => {
    root = mkdtempSync(path.join(process.cwd(), "tmp-encoded-name-"));
    output = compile(
      root,
      fixture,
      "Typra.Fixtures.Features.EncodedName.Root",
      TARGETS,
    );
    for (const [, dir] of TARGETS) {
      generated.set(dir, readTree(path.join(root, "generated", dir)));
    }
  });

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const model = (dir: string, pattern: RegExp) =>
    pick(generated.get(dir)!, pattern);

  it("compiles the encoded-name fixture without diagnostics", () => {
    assert.match(output, /Compilation completed successfully/, output);
  });

  it("TypeScript loads and saves the encoded key", () => {
    for (const dir of ["typescript", "typescript-zod"]) {
      const source = model(dir, /^narration\.ts$/);
      assert.match(source, /durationMs\?: number/);
      assert.match(
        source,
        /instance\.durationMs = Number\(data\["duration_ms"\]\)/,
      );
      assert.match(source, /result\["duration_ms"\] = obj\.durationMs/);
      assert.match(source, /data\["voice_settings"\]/);
      assert.match(source, /result\["cue_points"\]/);
      assert.doesNotMatch(source, /\["durationMs"\]/);
      // Non-JSON encodings are ignored.
      assert.match(source, /data\["title"\]/);
      assert.doesNotMatch(source, /"Title"/);
      const shape = model(dir, /^shape\.ts$/);
      assert.match(shape, /"shape_kind"/);
      assert.doesNotMatch(shape, /\["shapeKind"\]/);
    }
    const zod = model("typescript-zod", /^narration\.ts$/);
    assert.match(zod, /"?duration_ms"?: z\.number\(\)\.optional\(\)/);
    assert.doesNotMatch(zod, /\bdurationMs: z\./);
  });

  it("Python loads and saves the encoded key", () => {
    for (const dir of ["python", "python-pydantic"]) {
      const source = model(dir, /_Narration\.py$/);
      assert.match(source, /duration_ms: int \| None/);
      assert.match(source, /instance\.duration_ms = data\["duration_ms"\]/);
      assert.match(source, /result\["duration_ms"\] = obj\.duration_ms/);
      assert.match(source, /result\["voice_settings"\]/);
      assert.doesNotMatch(source, /"durationMs"/);
      assert.doesNotMatch(source, /"Title"/);
      assert.match(model(dir, /_Shape\.py$/), /"shape_kind"/);
      assert.doesNotMatch(model(dir, /_Shape\.py$/), /\["shapeKind"\]/);
    }
    assert.match(
      model("python-pydantic", /_Narration\.py$/),
      /alias="duration_ms"/,
    );
  });

  it("Go loads and saves the encoded key", () => {
    const source = model("go", /^narration\.go$/);
    assert.match(
      source,
      /DurationMs\s+\*int32\s+`json:"duration_ms,omitempty" yaml:"duration_ms,omitempty"`/,
    );
    assert.match(source, /m\["duration_ms"\]/);
    assert.match(source, /result\["duration_ms"\] = \*obj\.DurationMs/);
    assert.doesNotMatch(source, /"durationMs/);
    assert.doesNotMatch(source, /"Title"/);
    const shape = model("go", /^shape\.go$/);
    assert.match(shape, /"shape_kind"/);
    assert.doesNotMatch(shape, /\["shapeKind"\]/);
  });

  it("Java loads and saves the encoded key", () => {
    for (const dir of ["java", "java-jackson"]) {
      const source = model(dir, /^Narration\.java$/);
      assert.match(source, /public Integer durationMs/);
      assert.match(source, /map\.get\("duration_ms"\)/);
      assert.match(source, /result\.put\("duration_ms", /);
      assert.doesNotMatch(source, /"durationMs"/);
      assert.doesNotMatch(source, /"Title"/);
      const shape = model(dir, /^Shape\.java$/);
      assert.match(shape, /"shape_kind"/);
      assert.doesNotMatch(shape, /"shapeKind"/);
    }
    assert.match(
      model("java-jackson", /^Narration\.java$/),
      /@JsonProperty\("duration_ms"\)/,
    );
  });

  it("C# loads and saves the encoded key", () => {
    const source = model("csharp", /^Narration\.cs$/);
    assert.match(source, /public int\? DurationMs/);
    assert.match(source, /TryGetValue\("duration_ms"/);
    assert.match(source, /result\["duration_ms"\] = obj\.DurationMs/);
    assert.doesNotMatch(source, /"durationMs"/);
    assert.doesNotMatch(source, /"Title"/);
    const shape = model("csharp", /^Shape\.cs$/);
    assert.match(shape, /"shape_kind"/);
    assert.doesNotMatch(shape, /"shapeKind"/);
  });

  it("Rust loads and saves the encoded key", () => {
    for (const dir of ["rust", "rust-serde"]) {
      const source = model(dir, /^narration\.rs$/);
      assert.match(source, /pub duration_ms: Option<i32>/);
      assert.match(source, /\.get\("duration_ms"\)/);
      assert.match(source, /insert\("duration_ms"\.to_string\(\)/);
      assert.doesNotMatch(source, /"durationMs"/);
      assert.doesNotMatch(source, /"Title"/);
      const shape = model(dir, /^shape\.rs$/);
      assert.match(shape, /"shape_kind"/);
      assert.doesNotMatch(shape, /"shapeKind"/);
    }
  });

  it("Swift loads and saves the encoded key", () => {
    for (const dir of ["swift", "swift-codable"]) {
      const source = model(dir, /narration\.swift$/);
      assert.match(source, /public var durationMs: Int32\?/);
      assert.match(source, /object\["duration_ms"\]/);
      assert.match(source, /result\["duration_ms"\] = value/);
      assert.doesNotMatch(source, /\["durationMs"\]/);
      assert.doesNotMatch(source, /"Title"/);
      const shape = model(dir, /shape\.swift$/);
      assert.match(shape, /"shape_kind"/);
      assert.doesNotMatch(shape, /\["shapeKind"\]/);
    }
  });

  it("a derived discriminator override inherits the base encoded key", () => {
    // Circle redeclares `shapeKind: "circle"` without its own @encodedName, so it
    // must keep Shape's `shape_kind` wire key — the key the parent's dispatch reads.
    for (const [, dir] of TARGETS) {
      const files = generated.get(dir)!;
      const source = [...files.entries()]
        .filter(
          ([name]) =>
            /(circle|shape)[^/]*$/i.test(name) && !/(^|\/)tests?\//.test(name),
        )
        .map(([, content]) => content)
        .join("\n");
      assert.match(source, /Circle/);
      assert.match(source, /shape_kind/, `${dir} Circle uses the base key`);
      assert.doesNotMatch(
        source,
        /"shapeKind[",]/,
        `${dir} Circle must not read/write the property name as a key`,
      );
    }
  });

  it("a derived coercion keys an inherited property by the base encoded key", () => {
    // ImageAsset's `@coerce` expands into Asset.assetId, encoded as `asset_id`:
    // the shorthand key and the expansion dict must use the base's wire key.
    const asset = (dir: string) =>
      model(
        dir,
        /(^|\/)(_?asset\.(ts|py|go|rs|swift)|ImageAsset\.(java|cs))$/i,
      );
    for (const [, dir] of TARGETS) {
      // Swift's scalar-coercion error label (`field: "assetId"`) names the property.
      assert.doesNotMatch(
        asset(dir),
        /(?<!field: )"assetId"/,
        `${dir} must not key the inherited coercion property by its name`,
      );
    }
    for (const dir of ["typescript", "typescript-zod"]) {
      assert.match(
        asset(dir),
        /static readonly shorthandProperty: string \| undefined = "asset_id"/,
      );
    }
    for (const dir of ["python", "python-pydantic"]) {
      assert.match(
        asset(dir),
        /_shorthand_property: ClassVar\[str \| None\] = "asset_id"/,
      );
    }
    assert.match(
      asset("go"),
      /expansion := map\[string\]interface\{\}\{"asset_id": v\}/,
    );
    const cs = asset("csharp");
    assert.match(cs, /ShorthandProperty => "asset_id"/);
    assert.match(cs, /\["asset_id"\] = stringValue/);
    for (const dir of ["java", "java-jackson"]) {
      assert.match(asset(dir), /SHORTHAND_PROPERTY = "asset_id"/);
    }
    for (const dir of ["swift", "swift-codable"]) {
      assert.match(
        asset(dir),
        /static let shorthandProperty: String\? = "asset_id"/,
      );
    }
  });

  it("records the inherited discriminator wire name in the IR", () => {
    const ast = JSON.parse(
      readFileSync(
        path.join(root, "generated", "json-ast", "model.json"),
        "utf8",
      ),
    );
    const shapes = ast.properties.find(
      (prop: { name: string }) => prop.name === "shapes",
    );
    const circle = shapes.type.childTypes.find(
      (child: { typeName: { name: string } }) =>
        child.typeName.name === "Circle",
    );
    const kind = circle.properties.find(
      (prop: { name: string }) => prop.name === "shapeKind",
    );
    assert.equal(kind.serializedName, "shape_kind");
  });

  it("renders hyphenated and punctuated encoded names as valid code in every runtime", () => {
    const narration = (dir: string) =>
      model(
        dir,
        /(^|\/)(_?narration\.(ts|py|go|rs|swift)|Narration\.(java|cs))$/i,
      );
    // Derived identifiers come from the property name, never the wire key.
    const cs = narration("csharp");
    assert.match(cs, /TryGetValue\("delay-ms", out var delayMsValue\)/);
    assert.match(
      cs,
      /TryGetValue\("fade-out \{ms\} \$100%", out var fadeOutMsValue\)/,
    );
    assert.doesNotMatch(cs, /delay-msValue|fade-out \{ms\} \$100%Value/);
    assert.match(
      cs,
      /context!\.At\("alt \{voice\} \$"\)\.Path \+ ": missing required field"/,
    );
    assert.doesNotMatch(cs, /\$"[^"\n]*alt \{voice\}/);

    const go = narration("go");
    assert.match(
      go,
      /DelayMs\s+\*int32\s+`json:"delay-ms,omitempty" yaml:"delay-ms,omitempty"`/,
    );
    assert.match(go, /m\["delay-ms"\]/);
    assert.match(go, /result\["fade-out \{ms\} \$100%"\] = \*obj\.FadeOutMs/);

    for (const dir of ["rust", "rust-serde"]) {
      const rust = narration(dir);
      assert.match(rust, /\.get\("delay-ms"\)/);
      assert.match(rust, /format!\("\{\}\.\{\}", path, "alt \{voice\} \$"\)/);
      // A wire key must never land inside a format string, where `{` is a placeholder.
      assert.doesNotMatch(
        rust,
        /format!\("[^"]*(alt \{voice\}|cue-map \{keyed\})/,
      );
    }

    for (const dir of ["python", "python-pydantic"]) {
      const python = narration(dir);
      assert.match(python, /data\["delay-ms"\]/);
      assert.match(
        python,
        /context\.at\("alt \{voice\} \$"\)\.path \+ ": missing required field"/,
      );
      assert.doesNotMatch(python, /\bf["'][^"'\n]*alt \{voice\}/);
    }

    for (const dir of ["typescript", "typescript-zod"]) {
      const ts = narration(dir);
      assert.match(ts, /data\["delay-ms"\]/);
      assert.match(ts, /result\["gain \{db\} %"\] = obj\.gainDb/);
    }
    assert.match(narration("typescript-zod"), /"delay-ms": z\./);

    for (const dir of ["java", "java-jackson"]) {
      const java = narration(dir);
      assert.match(java, /map\.get\("delay-ms"\)/);
      assert.match(java, /result\.put\("cue-map \{keyed\} \$%", /);
    }
    assert.match(narration("java-jackson"), /@JsonProperty\("delay-ms"\)/);

    for (const dir of ["swift", "swift-codable"]) {
      const swift = narration(dir);
      assert.match(swift, /object\["delay-ms"\]/);
      assert.match(swift, /result\["alt \{voice\} \$"\]/);
    }
  });

  it("Rust validates a renamed keyed collection with its collection helper", () => {
    for (const dir of ["rust", "rust-serde"]) {
      const rust = model(dir, /^narration\.rs$/);
      // The helper is matched by property name; the wire key only drives dict access.
      assert.match(
        rust,
        /if let Some\(collection\) = value\.get\("cue-map \{keyed\} \$%"\) \{\s*let collection_path = [^\n]*\n\s*match collection \{\s*serde_json::Value::Object\(entries\)/,
      );
      assert.doesNotMatch(
        rust,
        /value\.get\("cue-map \{keyed\} \$%"\)\.and_then\(\|candidate\| candidate\.as_array\(\)\)/,
      );
    }
  });

  it("generated round-trip tests feed the encoded key", () => {
    const expectations: Array<[string, RegExp]> = [
      ["typescript", /narration\.test\.ts$/],
      ["python", /test_.*narration.*\.py$/i],
      ["go", /narration_test\.go$/],
      ["java", /NarrationGeneratedTest\.java$/],
      ["csharp", /NarrationConversionTests\.cs$/],
      ["rust", /narration_test\.rs$/],
      ["swift", /NarrationTests\.swift$/],
    ];
    for (const [dir, pattern] of expectations) {
      const source = model(dir, pattern);
      assert.match(
        source,
        /duration_ms/,
        `${dir} tests should use the encoded key`,
      );
    }
  });

  it("records the wire name in the IR and export surfaces", () => {
    const ast = JSON.parse(
      readFileSync(
        path.join(root, "generated", "json-ast", "model.json"),
        "utf8",
      ),
    );
    const narration = ast.properties.find(
      (prop: { name: string }) => prop.name === "narration",
    );
    const duration = narration.type.properties.find(
      (prop: { name: string }) => prop.name === "durationMs",
    );
    assert.equal(duration.serializedName, "duration_ms");
    const title = narration.type.properties.find(
      (prop: { name: string }) => prop.name === "title",
    );
    assert.equal(title.serializedName, undefined);
  });
});

describe("@encodedName collisions (#337)", () => {
  it("reports typra-emitter-encoded-name-collision", () => {
    const root = mkdtempSync(
      path.join(process.cwd(), "tmp-encoded-name-collision-"),
    );
    try {
      const source = path.join(root, "main.tsp");
      writeFileSync(
        source,
        [
          'import "@typra/emitter";',
          "",
          "namespace Probe;",
          "",
          "@serializable",
          "model Root {",
          "  child: Child;",
          "}",
          "",
          "model Base {",
          "  total?: int32;",
          "}",
          "",
          // The compiler's own `encoded-name-conflict` only checks one model's
          // declared members; an encoded name colliding with an inherited
          // property's wire key is caught by Typra.
          "model Child extends Base {",
          '  @encodedName("application/json", "total")',
          "  count?: int32;",
          "}",
          "",
        ].join("\n"),
      );
      const output = compile(root, source, "Probe.Root", [
        ["TypeScript", "typescript"],
      ]);
      assert.match(output, /typra-emitter-encoded-name-collision/);
      assert.match(output, /total/);
      assert.match(output, /count/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports typra-emitter-invalid-encoded-name for names no backend can carry", () => {
    const root = mkdtempSync(
      path.join(process.cwd(), "tmp-encoded-name-invalid-"),
    );
    try {
      const source = path.join(root, "main.tsp");
      writeFileSync(
        source,
        [
          'import "@typra/emitter";',
          "",
          "namespace Probe;",
          "",
          "@serializable",
          "model Root {",
          '  @encodedName("application/json", "a,b")',
          "  comma?: int32;",
          '  @encodedName("application/json", "-")',
          "  dash?: int32;",
          `  @encodedName("application/json", "it's")`,
          "  apostrophe?: int32;",
          '  @encodedName("application/json", "fade-out {ms}")',
          "  spaced?: int32;",
          '  @encodedName("application/json", "duration-ms")',
          "  durationMs?: int32;",
          "}",
          "",
        ].join("\n"),
      );
      const output = compile(root, source, "Probe.Root", [
        ["TypeScript", "typescript"],
      ]);
      const reported =
        output.match(/typra-emitter-invalid-encoded-name/g) ?? [];
      assert.equal(reported.length, 3, output);
      assert.match(output, /"it's".*Root\.apostrophe/);
      assert.match(output, /"a,b".*Root\.comma/);
      assert.match(output, /"-".*Root\.dash/);
      assert.doesNotMatch(output, /"duration-ms".*invalid|Root\.durationMs|Root\.spaced/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores non-JSON encoded names when checking collisions", () => {
    const root = mkdtempSync(path.join(process.cwd(), "tmp-encoded-name-xml-"));
    try {
      const source = path.join(root, "main.tsp");
      writeFileSync(
        source,
        [
          'import "@typra/emitter";',
          "",
          "namespace Probe;",
          "",
          "@serializable",
          "model Root {",
          "  child: Child;",
          "}",
          "",
          "model Base {",
          "  total?: int32;",
          "}",
          "",
          "model Child extends Base {",
          '  @encodedName("application/xml", "total")',
          "  count?: int32;",
          "}",
          "",
        ].join("\n"),
      );
      const output = compile(root, source, "Probe.Root", [
        ["TypeScript", "typescript"],
      ]);
      assert.doesNotMatch(output, /encoded-name-collision/);
      assert.match(output, /Compilation completed successfully/, output);
      const ts = [
        ...readTree(path.join(root, "generated", "typescript")).values(),
      ].join("\n");
      assert.match(ts, /instance\.count = Number\(data\["count"\]\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
