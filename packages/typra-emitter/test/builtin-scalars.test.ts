// Issue #359: built-in date/time, bytes, duration, url, and decimal scalars must render a
// concrete type in every target (their JSON wire form: string or float64) and load/save it,
// instead of raw names (Rust/Java/Swift), `any`/`object` fallbacks, or a TS `Date` that
// actually held a string.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  buildCSharp,
  buildGo,
  buildJava,
  buildPython,
  buildRust,
  buildSwift,
  buildTypeScript,
  generate,
  readSources,
  removeDir,
  scratchDir,
  toolAvailable,
} from "./native-probe.js";

const SPEC = `import "@typra/emitter";
namespace Typra.Probe.BuiltinScalars;

@serializable
model Root {
  createdAt: utcDateTime;
  birthday?: plainDate;
  alarm?: plainTime;
  localStamp?: offsetDateTime;
  payload?: bytes;
  timeout?: duration;
  homepage?: url;
  price: decimal;
  bigPrice?: decimal128;
  history?: utcDateTime[];
  stamps?: Record<utcDateTime>;
}

interface Clock {
  stamp(at: utcDateTime, amount: decimal): utcDateTime[];
}
`;
const ROOT = "Typra.Probe.BuiltinScalars.Root";

const INPUT_JSON = JSON.stringify({
  createdAt: "2024-01-02T03:04:05Z",
  birthday: "2024-01-02",
  alarm: "03:04:05",
  localStamp: "2024-01-02T03:04:05+02:00",
  payload: "aGVsbG8=",
  timeout: "PT1H",
  homepage: "https://example.test/",
  price: 12.5,
  bigPrice: 0.25,
  history: ["2024-01-01T00:00:00Z"],
  stamps: { first: "2024-01-01T00:00:00Z" },
});

describe("built-in scalars render concrete wire types (#359)", () => {
  let root = "";
  let out = "";

  before(() => {
    root = scratchDir("builtin-scalars");
    out = generate(root, SPEC, ROOT, [
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

  it("declares string and float64 fields in every target", () => {
    const optionalStrings = ["birthday", "alarm", "local_stamp", "payload", "timeout", "homepage"];
    const cases: Array<[string, string, RegExp[]]> = [
      ["typescript", ".ts", [/createdAt: string/, /price: number/, /history\?: string\[\]/, /stamp\(at: string, amount: number\)/]],
      [
        "python",
        ".py",
        [
          /created_at : str\b/,
          /price : float\b/,
          /big_price : Optional\[float\]/,
          /stamps : Optional\[dict\[str, str\]\]/,
          ...optionalStrings.map((field) => new RegExp(`\\b${field} : Optional\\[str\\]`)),
        ],
      ],
      ["go", ".go", [/CreatedAt\s+string\s/, /Price\s+float64\s/, /History\s+\[\]string\s/]],
      ["csharp", ".cs", [/public string CreatedAt \{/, /public double Price \{/]],
      ["java", ".java", [/public String createdAt = "";/, /public Double price = 0\.0d;/, /public Double bigPrice = null;/]],
      [
        "rust",
        ".rs",
        [
          /pub created_at: String,/,
          /pub price: f64,/,
          /pub big_price: Option<f64>,/,
          /pub history: Option<Vec<String>>,/,
          ...optionalStrings.map((field) => new RegExp(`pub ${field}: Option<String>,`)),
        ],
      ],
      ["swift", ".swift", [/var createdAt: String = ""/, /var price: Double = 0/, /func stamp\(at: String, amount: Double\) async throws -> \[String\]/]],
    ];
    for (const [target, extension, patterns] of cases) {
      const source = readSources(path.join(out, target), extension);
      for (const pattern of patterns) assert.match(source, pattern, target);
      assert.doesNotMatch(
        source,
        /\b(utcDateTime|plainDate|plainTime|offsetDateTime|UtcDateTime|PlainDate|PlainTime|OffsetDateTime|Decimal128|decimal128)\b|: Date\b|Uint8Array/,
        `${target} leaked a raw built-in scalar name`,
      );
    }
  });

  it("round-trips natively in TypeScript (strict)", () => {
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

  it("round-trips natively in Python", (t) => {
    if (!toolAvailable("uv")) return t.skip("uv not available");
    const output = buildPython(
      path.join(out, "python"),
      [
        "import json",
        "from probe_model import Root",
        `data = json.loads(${JSON.stringify(INPUT_JSON)})`,
        "root = Root.load(data)",
        'assert root.created_at == "2024-01-02T03:04:05Z" and root.price == 12.5, vars(root)',
        "assert root.save() == data, root.save()",
        'print("py-roundtrip-ok")',
        "",
      ].join("\n"),
    );
    assert.match(output, /py-roundtrip-ok/);
  });

  it("round-trips natively in Go", (t) => {
    if (!toolAvailable("go", ["version"])) return t.skip("go not available");
    buildGo(
      path.join(out, "go"),
      [
        'import (\n\t"encoding/json"\n\t"reflect"\n\t"testing"\n)',
        "",
        "func TestBuiltinScalarsRoundTrip(t *testing.T) {",
        `\tinput := ${JSON.stringify(INPUT_JSON)}`,
        "\tloaded, err := RootFromJSON(input)",
        "\tif err != nil {",
        "\t\tt.Fatal(err)",
        "\t}",
        '\tif loaded.CreatedAt != "2024-01-02T03:04:05Z" || loaded.Price != 12.5 {',
        '\t\tt.Fatalf("load => %+v", loaded)',
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

  it("round-trips natively in C#", (t) => {
    if (!toolAvailable("dotnet")) return t.skip("dotnet not available");
    const output = buildCSharp(
      path.join(out, "csharp"),
      [
        "using System.Text.Json.Nodes;",
        "using Typra.Probe.BuiltinScalars;",
        "",
        `var input = ${JSON.stringify(INPUT_JSON)};`,
        "var root = Root.FromJson(input);",
        'if (root.CreatedAt != "2024-01-02T03:04:05Z" || root.Price != 12.5) throw new Exception("load");',
        "var saved = root.ToJson();",
        "if (!JsonNode.DeepEquals(JsonNode.Parse(input), JsonNode.Parse(saved)))",
        '    throw new Exception($"round trip => {saved}");',
        'Console.WriteLine("cs-roundtrip-ok");',
        "",
      ].join("\n"),
    );
    assert.match(output, /cs-roundtrip-ok/);
  });

  it("round-trips natively in Java", (t) => {
    if (!toolAvailable("javac", ["-version"])) return t.skip("javac not available");
    const output = buildJava(
      path.join(out, "java"),
      [
        "public class Main {",
        "  public static void main(String[] args) {",
        "    typra.probe.builtinscalars.Root root =",
        `        typra.probe.builtinscalars.Root.fromJson(${JSON.stringify(INPUT_JSON)});`,
        '    if (!"2024-01-02T03:04:05Z".equals(root.createdAt) || root.price != 12.5) throw new IllegalStateException("load");',
        "    java.util.Map<String, Object> saved = root.save(null);",
        '    if (!"PT1H".equals(saved.get("timeout")) || !Double.valueOf(0.25).equals(saved.get("bigPrice")))',
        '      throw new IllegalStateException("save " + saved);',
        '    if (!java.util.List.of("2024-01-01T00:00:00Z").equals(saved.get("history")))',
        '      throw new IllegalStateException("history " + saved);',
        '    System.out.println("java-roundtrip-ok");',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    assert.match(output, /java-roundtrip-ok/);
  });

  it("round-trips natively in Rust", (t) => {
    if (!toolAvailable("cargo")) return t.skip("cargo not available");
    buildRust(
      path.join(out, "rust"),
      [
        "use probe::model::probe::builtin_scalars::Root;",
        "use probe::model::{LoadContext, SaveContext};",
        "",
        "#[test]",
        "fn builtin_scalars_round_trip() {",
        `    let input: serde_json::Value = serde_json::from_str(r#"${INPUT_JSON}"#).unwrap();`,
        "    let root = Root::load_from_value(&input, &LoadContext::default());",
        '    assert_eq!(root.created_at, "2024-01-02T03:04:05Z");',
        "    assert_eq!(root.price, 12.5);",
        "    assert_eq!(root.to_value(&SaveContext::default()), input);",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("round-trips natively in Swift", (t) => {
    if (!toolAvailable("swift")) return t.skip("swift not available");
    const output = buildSwift(
      path.join(out, "swift"),
      [
        "import Foundation",
        "import MODULE",
        `let input = try JSONSerialization.jsonObject(with: Data(${JSON.stringify(INPUT_JSON)}.utf8)) as! [String: Any]`,
        "let root = try Root.load(input)",
        'precondition(root.createdAt == "2024-01-02T03:04:05Z" && root.price == 12.5, "load")',
        "let saved = try root.save()",
        'precondition(NSDictionary(dictionary: saved).isEqual(to: input), "round trip \\(saved)")',
        'print("swift-roundtrip-ok")',
        "",
      ].join("\n"),
    );
    assert.match(output, /swift-roundtrip-ok/);
  });
});
