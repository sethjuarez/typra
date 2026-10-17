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
import {
  buildCSharp,
  buildGo,
  buildJava,
  generate,
  packageRoot,
  removeDir,
  scratchDir,
  toolAvailable,
} from "./native-probe.js";
const require = createRequire(import.meta.url);
const TARGETS = [
  ["Go", "go"],
  ["CSharp", "csharp"],
  ["Java", "java"],
] as const;
const WIRE_VALUES = [
  "kebab-case",
  "with space",
  "1x",
  "dot.ted",
  "dot ted",
  "UPPER",
  "upper",
  "",
  "a",
] as const;

function tspCli(): string {
  const compilerEntry = require.resolve("@typespec/compiler");
  const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
  return path.join(compilerRoot, "cmd", "tsp.js");
}

function compile(root: string): Map<string, string> {
  const fixture = path.join(
    process.cwd(),
    "fixtures",
    "features",
    "string-enum-identifiers",
    "main.tsp",
  );
  const generated = path.join(root, "generated");
  const lines = [
    "emit:",
    '  - "@typra/emitter"',
    "options:",
    '  "@typra/emitter":',
    `    emitter-output-dir: ${JSON.stringify(generated)}`,
    '    root-object: "Typra.Fixtures.Features.StringEnumIdentifiers.Root"',
    "    deterministic-output: true",
    "    emit-targets:",
  ];
  for (const [type, dir] of TARGETS) {
    lines.push(`      - type: ${type}`);
    lines.push(
      `        output-dir: ${JSON.stringify(path.join(generated, dir))}`,
    );
    lines.push(
      `        test-dir: ${JSON.stringify(path.join(generated, dir, "tests"))}`,
    );
    lines.push("        format: false");
  }
  const config = path.join(root, "tspconfig.yaml");
  writeFileSync(config, [...lines, ""].join("\n"));
  const result = spawnSync(
    process.execPath,
    [tspCli(), "compile", fixture, "--config", config],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else
        files.set(
          path.relative(generated, full).split(path.sep).join("/"),
          readFileSync(full, "utf8"),
        );
    }
  };
  walk(generated);
  return files;
}

function generatedSource(
  files: Map<string, string>,
  target: string,
  declaration: string,
): string {
  const source = [...files.entries()].find(
    ([name, content]) =>
      name.startsWith(`${target}/`) &&
      !name.includes("/tests/") &&
      content.includes(declaration),
  )?.[1];
  assert.ok(source, `${target} ${declaration} was not generated`);
  return source;
}

function enumBlock(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `missing ${declaration}`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("\n}", open);
  assert.notEqual(close, -1, `unterminated ${declaration}`);
  return source.slice(open + 1, close);
}

function assertUniqueValidNames(names: string[], target: string): void {
  assert.equal(
    new Set(names).size,
    names.length,
    `${target} enum names collide`,
  );
  for (const name of names) {
    assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/, `${target}: ${name}`);
  }
}

describe("arbitrary string-union enum identifiers", () => {
  let root = "";
  let files = new Map<string, string>();

  before(() => {
    root = mkdtempSync(
      path.join(process.cwd(), "tmp-string-enum-identifiers-"),
    );
    files = compile(root);
  });

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("emits unique valid Go constants with their original wire values", () => {
    const source = generatedSource(files, "go", "type Odd string");
    const entries = [
      ...source.matchAll(/^\s*(Odd\w*)\s+Odd = ("(?:\\.|[^"\\])*")$/gm),
    ];
    const names = entries.map((entry) => entry[1]);
    assert.equal(entries.length, 5, source);
    assertUniqueValidNames(names, "Go");
    const emptySource = generatedSource(files, "go", "type Empty string");
    assert.match(emptySource, /EmptyValue\s+Empty = ""/);
    assert.match(emptySource, /EmptyA\s+Empty = "a"/);
    for (const value of WIRE_VALUES.slice(0, 5)) {
      assert.ok(
        entries.some((entry) => JSON.parse(entry[2]) === value),
        `Go lost ${JSON.stringify(value)}`,
      );
    }
  });

  it("emits unique valid C# members and maps them back to wire values", () => {
    const source = generatedSource(files, "csharp", "public enum Odd");
    const names = [
      ...enumBlock(source, "public enum Odd").matchAll(
        /^\s+([A-Za-z_][A-Za-z0-9_]*),$/gm,
      ),
    ].map((entry) => entry[1]);
    assert.equal(names.length, 5);
    assertUniqueValidNames(names, "C#");
    for (const value of WIRE_VALUES.slice(0, 5)) {
      assert.ok(
        source.includes(`=> ${JSON.stringify(value)},`),
        `C# lost ${JSON.stringify(value)}`,
      );
    }
    const pairSource = generatedSource(files, "csharp", "public enum CasePair");
    const pairNames = [
      ...enumBlock(pairSource, "public enum CasePair").matchAll(
        /^\s+([A-Za-z_][A-Za-z0-9_]*),$/gm,
      ),
    ].map((entry) => entry[1]);
    assertUniqueValidNames(pairNames, "C# case pair");
    assert.equal(pairNames.length, 2);
    const emptySource = generatedSource(files, "csharp", "public enum Empty");
    const emptyNames = [
      ...enumBlock(emptySource, "public enum Empty").matchAll(
        /^\s+([A-Za-z_][A-Za-z0-9_]*),$/gm,
      ),
    ].map((entry) => entry[1]);
    assert.deepEqual(emptyNames, ["Value", "A"]);
    assert.ok(emptySource.includes('=> "",'));
  });

  it("emits unique valid Java constants and preserves case-distinct values", () => {
    const source = generatedSource(files, "java", "enum Odd {");
    const names = [
      ...enumBlock(source, "enum Odd").matchAll(
        /^\s+([A-Za-z_$][A-Za-z0-9_$]*)\("(?:\\.|[^"\\])*"\),$/gm,
      ),
    ].map((entry) => entry[1]);
    assert.equal(names.length, 5);
    assertUniqueValidNames(names, "Java");
    for (const value of WIRE_VALUES.slice(0, 5)) {
      assert.ok(
        source.includes(`("${value}")`),
        `Java lost ${JSON.stringify(value)}`,
      );
    }
    const pairSource = generatedSource(files, "java", "enum CasePair {");
    const pairNames = [
      ...enumBlock(pairSource, "enum CasePair").matchAll(
        /^\s+([A-Za-z_$][A-Za-z0-9_$]*)\("(?:\\.|[^"\\])*"\),$/gm,
      ),
    ].map((entry) => entry[1]);
    assert.equal(pairNames.length, 2);
    assertUniqueValidNames(pairNames, "Java case pair");
    assert.ok(pairSource.includes('UPPER("UPPER")'));
    assert.ok(pairSource.includes('UPPER_2("upper")'));
    assert.ok(pairSource.includes("fromValue(String value)"));
    const emptySource = generatedSource(files, "java", "enum Empty {");
    assert.ok(emptySource.includes('VALUE(""),'));
    assert.ok(emptySource.includes('A("a"),'));
  });
});

const ROOT_OBJECT = "Typra.Fixtures.Features.StringEnumIdentifiers.Root";
const FIXTURE = path.join(
  packageRoot,
  "fixtures",
  "features",
  "string-enum-identifiers",
  "main.tsp",
);
const ROUND_TRIPS: Array<[keyof typeof MEMBERS, string]> = [
  ["odd", "kebab-case"],
  ["odd", "with space"],
  ["odd", "1x"],
  ["odd", "dot.ted"],
  ["odd", "dot ted"],
  ["pair", "UPPER"],
  ["pair", "upper"],
  ["empty", ""],
  ["empty", "a"],
];
const MEMBERS = {
  odd: {
    go: ["OddKebab_case", "OddWith_space", "Odd1x", "OddDot_ted", "OddDot_ted_2"],
    csharp: ["Odd.Kebab_case", "Odd.With_space", "Odd.Value1x", "Odd.Dot_ted", "Odd.Dot_ted_2"],
    java: ["Odd.KEBAB_CASE", "Odd.WITH_SPACE", "Odd._1X", "Odd.DOT_TED", "Odd.DOT_TED_2"],
  },
  pair: {
    go: ["CasePairUPPER", "CasePairUpper"],
    csharp: ["CasePair.UPPER", "CasePair.Upper"],
    java: ["CasePair.UPPER", "CasePair.UPPER_2"],
  },
  empty: {
    go: ["EmptyValue", "EmptyA"],
    csharp: ["Empty.Value", "Empty.A"],
    java: ["Empty.VALUE", "Empty.A"],
  },
} as const;

/** Each wire value paired with the generated member it must load as, per target. */
function cases(target: "go" | "csharp" | "java") {
  const seen = { odd: 0, pair: 0, empty: 0 };
  return ROUND_TRIPS.map(([field, value]) => ({
    field,
    value,
    member: MEMBERS[field][target][seen[field]++],
    json: JSON.stringify({
      odd: field === "odd" ? value : "1x",
      pair: field === "pair" ? value : "UPPER",
      empty: field === "empty" ? value : "a",
    }),
  }));
}

describe("arbitrary string-union enum identifiers (native)", () => {
  let root = "";

  before(() => {
    root = scratchDir("enum-identifiers-native");
    generate(root, FIXTURE, ROOT_OBJECT, ["go", "csharp", "java"]);
  });

  after(() => removeDir(root));

  it("compiles in Go and round-trips every wire value", (t) => {
    if (!toolAvailable("go", ["version"])) return t.skip("go not available");
    const checks = cases("go")
      .map(({ field, member, json }) => {
        const prop = field === "odd" ? "Odd" : field === "pair" ? "Pair" : "Empty";
        return [
          `\tcheck(t, ${JSON.stringify(json)}, func(r Root) bool { return r.${prop} == ${member} })`,
        ].join("\n");
      })
      .join("\n");
    buildGo(
      path.join(root, "out", "go"),
      [
        'import (\n\t"encoding/json"\n\t"reflect"\n\t"testing"\n)',
        "",
        "func check(t *testing.T, input string, member func(Root) bool) {",
        "\tloaded, err := RootFromJSON(input)",
        "\tif err != nil || !member(loaded) {",
        '\t\tt.Fatalf("load %s: %+v %v", input, loaded, err)',
        "\t}",
        "\tsaved, err := loaded.ToJSON()",
        "\tif err != nil {",
        "\t\tt.Fatal(err)",
        "\t}",
        "\tvar want, got map[string]any",
        "\t_ = json.Unmarshal([]byte(input), &want)",
        "\t_ = json.Unmarshal([]byte(saved), &got)",
        "\tif !reflect.DeepEqual(want, got) {",
        '\t\tt.Fatalf("round trip %s => %s", input, saved)',
        "\t}",
        "}",
        "",
        "func TestEnumRoundTrip(t *testing.T) {",
        checks,
        "}",
        "",
      ].join("\n"),
    );
  });

  it("compiles in C# and round-trips every wire value", (t) => {
    if (!toolAvailable("dotnet")) return t.skip("dotnet not available");
    const checks = cases("csharp")
      .map(({ field, value, member, json }) => {
        const prop = field === "odd" ? "Odd" : field === "pair" ? "Pair" : "Empty";
        return `Check(${JSON.stringify(json)}, r => r.${prop} == ${member}, ${JSON.stringify(field)}, ${JSON.stringify(value)});`;
      })
      .join("\n");
    const output = buildCSharp(
      path.join(root, "out", "csharp"),
      [
        "using System.Text.Json.Nodes;",
        "using Typra.Fixtures.Features.StringEnumIdentifiers;",
        "",
        checks,
        'Console.WriteLine("enum-roundtrip-ok");',
        "",
        "static void Check(string input, Func<Root, bool> member, string field, string value)",
        "{",
        "    var loaded = Root.FromJson(input);",
        '    if (!member(loaded)) throw new Exception($"load {input}");',
        "    var saved = JsonNode.Parse(loaded.ToJson())!;",
        "    if (saved[field]!.GetValue<string>() != value)",
        '        throw new Exception($"round trip {input} => {saved.ToJsonString()}");',
        "}",
        "",
      ].join("\n"),
    );
    assert.match(output, /enum-roundtrip-ok/);
  });

  it("compiles in Java and round-trips every wire value", (t) => {
    if (!toolAvailable("javac", ["-version"])) return t.skip("javac not available");
    const pkg = "typra.fixtures.features.stringenumidentifiers";
    const checks = cases("java")
      .map(({ field, value, member, json }) =>
        `    check(${JSON.stringify(json)}, ${pkg}.Root.fromJson(${JSON.stringify(json)}).${field} == ${pkg}.${member}, ${JSON.stringify(field)}, ${JSON.stringify(value)});`,
      )
      .join("\n");
    const output = buildJava(
      path.join(root, "out", "java"),
      [
        "public class Main {",
        "  public static void main(String[] args) {",
        checks,
        '    System.out.println("enum-roundtrip-ok");',
        "  }",
        "",
        "  static void check(String input, boolean member, String field, String value) {",
        '    if (!member) throw new IllegalStateException("load " + input);',
        `    Object saved = ${pkg}.Root.fromJson(input).save(null).get(field);`,
        '    if (!value.equals(saved)) throw new IllegalStateException("round trip " + input + " => " + saved);',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    assert.match(output, /enum-roundtrip-ok/);
  });
});
