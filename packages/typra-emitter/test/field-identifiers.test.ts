// Issue #356: source field identifiers must stay valid in each target while encoded
// JSON names remain the keys used by generated loading and saving.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { RustExprVisitor } from "../src/languages/rust/visitor.js";
import {
  pythonDispatchIdentifier,
  pythonFieldName,
} from "../src/languages/python/identifiers.js";
import {
  buildCSharp,
  buildGo,
  buildJava,
  buildPython,
  buildRust,
  buildSwift,
  buildTypeScript,
  generate,
  packageRoot,
  readSources,
  removeDir,
  scratchDir,
  toolAvailable,
} from "./native-probe.js";

const FIXTURE = path.join(
  packageRoot,
  "fixtures",
  "features",
  "field-identifiers",
  "main.tsp",
);
const ROOT = "Typra.Fixtures.Features.FieldIdentifiers.Root";

const KEYWORDS =
  "def lambda yield pass from async await func range chan go select default where protocol struct match loop mut ref move fn event object string delete new this let in type var static return true false nil null None".split(
    " ",
  );
const WIRE_KEYS = ["class", "import", "self", "super", "crate", "x-trace-id", "2fa", ...KEYWORDS];
const INPUT_JSON = JSON.stringify(
  Object.fromEntries(WIRE_KEYS.map((key) => [key, `v-${key}`])),
);

function rustString(value: string): string {
  return `r#"${value}"#`;
}

function sources(out: string, target: string, extension: string): string {
  return readSources(path.join(out, target), extension);
}

describe("field identifiers and encoded wire names (#356)", () => {
  let root = "";
  let out = "";

  before(() => {
    root = scratchDir("field-identifiers");
    out = generate(root, FIXTURE, ROOT, [
      "typescript",
      "python",
      "go",
      "csharp",
      "java",
      "rust",
      "swift",
    ]);
  });

  after(() => removeDir(root));

  it("keeps source identifiers distinct from encoded wire keys in all targets", () => {
    const cases = [
      {
        target: "typescript",
        extension: ".ts",
        identifiers: [
          "className",
          "importName",
          "self",
          "super",
          "crate",
          "traceId",
          "twoFa",
        ],
      },
      {
        target: "python",
        extension: ".py",
        identifiers: [
          "class_name",
          "import_name",
          "self",
          "super",
          "crate",
          "trace_id",
          "two_fa",
        ],
      },
      {
        target: "go",
        extension: ".go",
        identifiers: [
          "ClassName",
          "ImportName",
          "Self",
          "Super",
          "Crate",
          "TraceId",
          "TwoFa",
        ],
      },
      {
        target: "csharp",
        extension: ".cs",
        identifiers: [
          "ClassName",
          "ImportName",
          "Self",
          "Super",
          "Crate",
          "TraceId",
          "TwoFa",
        ],
      },
      {
        target: "rust",
        extension: ".rs",
        identifiers: [
          "class_name",
          "import_name",
          "self_",
          "super_",
          "crate_",
          "trace_id",
          "two_fa",
        ],
      },
      {
        target: "swift",
        extension: ".swift",
        identifiers: [
          "className",
          "importName",
          "`self`",
          "super",
          "crate",
          "traceId",
          "twoFa",
        ],
      },
    ];
    const wireNames = [
      '"class"',
      '"import"',
      '"self"',
      '"super"',
      '"crate"',
      '"x-trace-id"',
      '"2fa"',
    ];

    for (const { target, extension, identifiers } of cases) {
      const code = sources(out, target, extension);
      for (const identifier of identifiers) {
        assert.ok(
          code.includes(identifier),
          `${target} should emit ${identifier}`,
        );
      }
      for (const wireName of wireNames) {
        assert.ok(
          code.includes(wireName),
          `${target} should preserve ${wireName}`,
        );
      }
    }

    const rust = sources(out, "rust", ".rs");
    assert.match(rust, /pub self_: Option<String>/);
    assert.match(rust, /pub super_: Option<String>/);
    assert.match(rust, /pub crate_: Option<String>/);
    assert.match(rust, /self_: value\.get\("self"\)/);
    assert.match(rust, /super_: value\.get\("super"\)/);
    assert.match(rust, /crate_: value\.get\("crate"\)/);
    assert.match(rust, /self\.self_\.as_ref\(\)/);
    assert.doesNotMatch(rust, /r#self/);
    assert.equal(
      new RustExprVisitor().visitExpr({
        kind: "field_read",
        objectName: "root",
        fieldName: "self",
        fieldType: "string",
        isOptional: false,
      }),
      "root.self_",
    );
  });

  it("reports collisions caused by Rust keyword escaping", () => {
    const collisionRoot = scratchDir("field-identifiers-collision");
    try {
      assert.throws(
        () =>
          generate(
            collisionRoot,
            [
              'import "@typra/emitter";',
              "namespace Probe;",
              "@serializable model Root { self?: string; self_?: string; }",
              "",
            ].join("\n"),
            "Probe.Root",
            ["rust"],
          ),
        /Rust type Root: fields "self" and "self_" both map to the identifier "self_"/,
      );
    } finally {
      removeDir(collisionRoot);
    }
  });

  it("escapes target keywords in source identifiers only", () => {
    const rust = sources(out, "rust", ".rs");
    for (const keyword of ["yield", "fn", "match", "type", "move", "ref", "loop", "mut"]) {
      assert.match(rust, new RegExp(`pub r#${keyword}: Option<String>`));
    }
    const python = sources(out, "python", ".py");
    for (const keyword of ["def", "lambda", "yield", "pass", "from", "async", "await", "return"]) {
      assert.match(python, new RegExp(`\\b${keyword}_\\b`));
    }
    assert.doesNotMatch(python, /^\s+(def|lambda|yield|from|async|await|return|pass)\s*:/m);
    // Only `True`/`False`/`None` are keywords; snake_case lowercases, so these stay as-is.
    for (const name of ["true", "false", "none"]) {
      assert.match(python, new RegExp(`^\\s+${name}: `, "m"));
      assert.doesNotMatch(python, new RegExp(`\\b${name}_\\b`));
    }
    assert.equal(pythonFieldName("None"), "none");
    assert.equal(pythonFieldName("class"), "class_");
    assert.equal(pythonDispatchIdentifier("none"), "none_");
    assert.equal(pythonDispatchIdentifier("class"), "class_");
    const swift = sources(out, "swift", ".swift");
    for (const keyword of ["await", "func", "default", "where", "protocol", "struct", "self"]) {
      assert.ok(swift.includes(`\`${keyword}\``), `swift should escape ${keyword}`);
    }
    assert.match(swift, /`self` _self: String\?/);
    assert.match(swift, /self\.`self` = _self/);
  });

  it("reports collisions caused by Python keyword escaping", () => {
    const collisionRoot = scratchDir("field-identifiers-py-collision");
    try {
      assert.throws(
        () =>
          generate(
            collisionRoot,
            [
              'import "@typra/emitter";',
              "namespace Probe;",
              "@serializable model Root { `def`?: string; def_?: string; }",
              "",
            ].join("\n"),
            "Probe.Root",
            ["python"],
          ),
        /Python type Root: fields "def" and "def_" both map to the attribute "def_"/,
      );
    } finally {
      removeDir(collisionRoot);
    }
  });

  it("round-trips every key natively in Rust", (t) => {
    if (!toolAvailable("cargo")) return t.skip("cargo not available");
    buildRust(
      path.join(out, "rust"),
      [
        "use probe::model::fixtures::features::field_identifiers::Root;",
        "use probe::model::{LoadContext, SaveContext};",
        "",
        "#[test]",
        "fn encoded_names_round_trip() {",
        `    let input: serde_json::Value = serde_json::from_str(${rustString(INPUT_JSON)}).unwrap();`,
        "    let root = Root::load_from_value(&input, &LoadContext::default());",
        '    assert_eq!(root.self_.as_deref(), Some("v-self"));',
        '    assert_eq!(root.r#yield.as_deref(), Some("v-yield"));',
        "    assert_eq!(root.to_value(&SaveContext::default()), input);",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("round-trips every key natively in TypeScript (strict)", () => {
    const output = buildTypeScript(
      path.join(out, "typescript"),
      [
        'const { Root } = require("./index.js");',
        `const input = ${INPUT_JSON};`,
        "const saved = Root.load(input).save();",
        "const same = JSON.stringify(Object.entries(saved).sort()) === JSON.stringify(Object.entries(input).sort());",
        'if (!same) throw new Error("round trip " + JSON.stringify(saved));',
        'console.log("ts-roundtrip-ok");',
        "",
      ].join("\n"),
    );
    assert.match(output, /ts-roundtrip-ok/);
  });

  it("round-trips every key natively in Python", (t) => {
    if (!toolAvailable("uv")) return t.skip("uv not available");
    const output = buildPython(
      path.join(out, "python"),
      [
        "import json",
        "from probe_model import Root",
        `data = json.loads(${JSON.stringify(INPUT_JSON)})`,
        "root = Root.load(data)",
        'assert root.def_ == "v-def" and root.self == "v-self", vars(root)',
        'assert (root.true, root.false, root.none) == ("v-true", "v-false", "v-None"), vars(root)',
        "assert root.save() == data, root.save()",
        'print("py-roundtrip-ok")',
        "",
      ].join("\n"),
    );
    assert.match(output, /py-roundtrip-ok/);
  });

  it("round-trips every key natively in Go", (t) => {
    if (!toolAvailable("go", ["version"])) return t.skip("go not available");
    buildGo(
      path.join(out, "go"),
      [
        'import (\n\t"encoding/json"\n\t"reflect"\n\t"testing"\n)',
        "",
        "func TestFieldIdentifiersRoundTrip(t *testing.T) {",
        `\tinput := ${JSON.stringify(INPUT_JSON)}`,
        "\tloaded, err := RootFromJSON(input)",
        "\tif err != nil {",
        "\t\tt.Fatal(err)",
        "\t}",
        "\tsaved, err := loaded.ToJSON()",
        "\tif err != nil {",
        "\t\tt.Fatal(err)",
        "\t}",
        "\tvar want, got map[string]any",
        "\t_ = json.Unmarshal([]byte(input), &want)",
        "\t_ = json.Unmarshal([]byte(saved), &got)",
        "\tif !reflect.DeepEqual(want, got) {",
        '\t\tt.Fatalf("round trip => %s", saved)',
        "\t}",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("round-trips every key natively in C#", (t) => {
    if (!toolAvailable("dotnet")) return t.skip("dotnet not available");
    const output = buildCSharp(
      path.join(out, "csharp"),
      [
        "using System.Text.Json.Nodes;",
        "using Typra.Fixtures.Features.FieldIdentifiers;",
        "",
        `var input = ${JSON.stringify(INPUT_JSON)};`,
        "var saved = Root.FromJson(input).ToJson();",
        "if (!JsonNode.DeepEquals(JsonNode.Parse(input), JsonNode.Parse(saved)))",
        '    throw new Exception($"round trip => {saved}");',
        'Console.WriteLine("cs-roundtrip-ok");',
        "",
      ].join("\n"),
    );
    assert.match(output, /cs-roundtrip-ok/);
  });

  it("round-trips every key natively in Java", (t) => {
    if (!toolAvailable("javac", ["-version"])) return t.skip("javac not available");
    const pkg = "typra.fixtures.features.fieldidentifiers";
    const output = buildJava(
      path.join(out, "java"),
      [
        "public class Main {",
        "  public static void main(String[] args) {",
        `    String[] keys = { ${WIRE_KEYS.map((key) => JSON.stringify(key)).join(", ")} };`,
        `    java.util.Map<String, Object> saved = ${pkg}.Root.fromJson(${JSON.stringify(INPUT_JSON)}).save(null);`,
        '    if (saved.size() != keys.length) throw new IllegalStateException("size " + saved);',
        "    for (String key : keys) {",
        '      if (!("v-" + key).equals(saved.get(key))) throw new IllegalStateException(key + " => " + saved);',
        "    }",
        '    System.out.println("java-roundtrip-ok");',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    assert.match(output, /java-roundtrip-ok/);
  });

  it("round-trips every key natively in Swift", (t) => {
    if (!toolAvailable("swift")) return t.skip("swift not available");
    const output = buildSwift(
      path.join(out, "swift"),
      [
        "import Foundation",
        "import MODULE",
        `let input = try JSONSerialization.jsonObject(with: Data(${JSON.stringify(INPUT_JSON)}.utf8)) as! [String: Any]`,
        "let root = try Root.load(input)",
        'precondition(root.`self` == "v-self" && root.`await` == "v-await", "load")',
        "let saved = try root.save()",
        "precondition(NSDictionary(dictionary: saved).isEqual(to: input), \"round trip \\(saved)\")",
        'print("swift-roundtrip-ok")',
        "",
      ].join("\n"),
    );
    assert.match(output, /swift-roundtrip-ok/);
  });
});
