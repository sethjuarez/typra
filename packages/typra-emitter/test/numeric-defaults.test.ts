// Issue #360: numeric literals must render as valid, value-preserving target code. Java turned
// `float64 = 1e300` into `1e+300.0d` (it appended `.0` to any integer-valued number, even one
// already in exponent form); C# assigned unsuffixed (double) literals to `float` members; and
// factory constructs printed raw numbers, so `float32[]` items and whole floats mistyped in
// Java, C# and Rust. The defaults fixture pins field defaults and a `literals` factory.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { javaNumericLiteral } from "../src/languages/java/identifiers.js";
import { csNumericLiteral } from "../src/languages/csharp/emitter.js";
import {
  buildCSharp,
  buildJava,
  buildRust,
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
  "defaults",
  "main.tsp",
);
const ROOT = "Typra.Fixtures.Features.Defaults.Root";

describe("numeric literal helpers (#360)", () => {
  it("Java keeps exponent forms and only adds `.0` to bare integers", () => {
    assert.equal(javaNumericLiteral(1e300, "float64"), "1e+300d");
    assert.equal(javaNumericLiteral(-1e300, "float64"), "-1e+300d");
    assert.equal(javaNumericLiteral(1e-300, "float64"), "1e-300d");
    assert.equal(javaNumericLiteral(1e30, "float32"), "1e+30f");
    assert.equal(javaNumericLiteral(2, "float64"), "2.0d");
    assert.equal(javaNumericLiteral(0.5, "float32"), "0.5f");
    assert.equal(javaNumericLiteral(9007199254740991, "int64"), "9007199254740991L");
    assert.equal(javaNumericLiteral(3, "int32"), "3");
  });

  it("Java narrows float literals javac would reject as too small", () => {
    assert.equal(javaNumericLiteral(1e-50, "float32"), "(float) 1e-50d");
    assert.equal(javaNumericLiteral(-1e-50, "float32"), "(float) -1e-50d");
    assert.equal(javaNumericLiteral(1e-45, "float32"), "1e-45f");
    assert.equal(javaNumericLiteral(0, "float32"), "0.0f");
  });

  it("C# suffixes floating literals for their member type", () => {
    assert.equal(csNumericLiteral(0.5, "float"), "0.5F");
    assert.equal(csNumericLiteral(2, "float"), "2F");
    assert.equal(csNumericLiteral(1e300, "double"), "1e+300");
    assert.equal(csNumericLiteral(123456789012345680000, "double"), "123456789012345680000D");
    assert.equal(csNumericLiteral(3, "int"), "3");
    assert.equal(csNumericLiteral("x", "double"), "x");
  });

  it("keeps the sign of negative zero", () => {
    assert.equal(javaNumericLiteral(-0, "float64"), "-0.0d");
    assert.equal(javaNumericLiteral(-0, "float32"), "-0.0f");
    assert.equal(csNumericLiteral(-0, "double"), "-0D");
    assert.equal(csNumericLiteral(-0, "float"), "-0F");
  });
});

describe("C# variant factory fields inherit numeric typing (#360)", () => {
  let root = "";
  after(() => removeDir(root));

  it("suffixes an inherited float32 set through a variant", (t) => {
    root = scratchDir("numeric-variant");
    const out = generate(
      root,
      [
        'import "@typra/emitter";',
        "namespace Probe;",
        "model Root { holder: Holder; }",
        '@discriminator("kind")',
        "model Shape { kind: string; weight: float32; }",
        'model Circle extends Shape { kind: "circle"; radius: float32; }',
        '@factory("heavy", #{ shape: #{ kind: "circle", weight: 0.5, radius: 1.5 } })',
        "model Holder { shape: Shape; }",
        "",
      ].join("\n"),
      "Probe.Root",
      ["csharp"],
    );
    const cs = readSources(path.join(out, "csharp"), ".cs");
    assert.match(cs, /Weight = 0\.5F/);
    assert.match(cs, /Radius = 1\.5F/);
    if (!toolAvailable("dotnet")) return t.skip("dotnet not available");
    buildCSharp(path.join(out, "csharp"));
  });
});

describe("numeric literals compile and keep their value (#360)", () => {
  let root = "";
  let out = "";

  before(() => {
    root = scratchDir("numeric-defaults");
    out = generate(root, FIXTURE, ROOT, ["java", "csharp", "rust"]);
  });

  after(() => removeDir(root));

  it("Java renders valid floating literals", () => {
    const java = readSources(path.join(out, "java"), ".java");
    assert.match(java, /largeExponent = 1e\+300d;/);
    assert.match(java, /tinyExponent = 1e-300d;/);
    assert.match(java, /negativeExponent = -1e\+300d;/);
    assert.match(java, /hugeWhole = 123456789012345680000\.0d;/);
    assert.match(java, /wideSingle = 1e\+30f;/);
    assert.match(java, /halfSingle = 0\.5f;/);
    assert.match(java, /tinySingle = \(float\) 1e-50d;/);
    assert.match(java, /Arrays\.asList\(0\.5f, 2\.0f\)/);
    assert.doesNotMatch(java, /e[+-]\d+\.0[df]/);
  });

  it("C# suffixes float defaults and factory values", () => {
    const cs = readSources(path.join(out, "csharp"), ".cs");
    assert.match(cs, /LargeExponent \{ get; set; \} = 1e\+300;/);
    assert.match(cs, /HugeWhole \{ get; set; \} = 123456789012345680000D;/);
    assert.match(cs, /WideSingle \{ get; set; \} = 1e\+30F;/);
    assert.match(cs, /HalfSingle \{ get; set; \} = 0\.5F;/);
    assert.match(cs, /HalfSingle = 0\.25F/);
    assert.match(cs, /new List<float> \{ 0\.5F, 2F \}/);
  });

  it("Rust renders whole floats in factories as float literals", () => {
    const rust = readSources(path.join(out, "rust"), ".rs");
    assert.match(rust, /singles: Some\(vec!\[0\.5, 2\.0\]\)/);
    assert.doesNotMatch(rust, /use .*::float32::float32;/);
  });

  it("javac accepts the literals and they hold their values", (t) => {
    if (!toolAvailable("javac", ["-version"])) return t.skip("javac not available");
    const output = buildJava(
      path.join(out, "java"),
      [
        "import typra.fixtures.features.defaults.DefaultsModel;",
        "public final class Main {",
        "  public static void main(String[] args) {",
        "    DefaultsModel m = new DefaultsModel();",
        "    if (m.largeExponent != 1e300 || m.tinyExponent != 1e-300",
        "        || m.negativeExponent != -1e300 || m.hugeWhole != 123456789012345680000d",
        "        || m.wideSingle != 1e30f || m.halfSingle != 0.5f || m.tinySingle != 0f) {",
        '      throw new AssertionError("default drifted");',
        "    }",
        "    DefaultsModel f = DefaultsModel.literals();",
        "    if (f.halfSingle != 0.25f || f.largeExponent != 1e300",
        "        || !f.singles.equals(java.util.List.of(0.5f, 2.0f))) {",
        '      throw new AssertionError("factory drifted");',
        "    }",
        '    System.out.println("LITERALS OK");',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    assert.match(output, /LITERALS OK/);
  });

  it("dotnet accepts the literals and they hold their values", (t) => {
    if (!toolAvailable("dotnet")) return t.skip("dotnet not available");
    const output = buildCSharp(
      path.join(out, "csharp"),
      [
        "using Typra.Fixtures.Features.Defaults;",
        "var m = new DefaultsModel();",
        "if (m.LargeExponent != 1e300 || m.TinyExponent != 1e-300",
        "    || m.NegativeExponent != -1e300 || m.HugeWhole != 123456789012345680000D",
        "    || m.WideSingle != 1e30F || m.HalfSingle != 0.5F || m.TinySingle != 0F)",
        '    throw new Exception("default drifted");',
        "var f = DefaultsModel.Literals();",
        "if (f.HalfSingle != 0.25F || f.LargeExponent != 1e300",
        "    || !f.Singles!.SequenceEqual(new[] { 0.5F, 2F }))",
        '    throw new Exception("factory drifted");',
        'Console.WriteLine("LITERALS OK");',
        "",
      ].join("\n"),
    );
    assert.match(output, /LITERALS OK/);
  });

  it("cargo accepts the factory literals and they hold their values", (t) => {
    if (!toolAvailable("cargo")) return t.skip("cargo not available");
    buildRust(
      path.join(out, "rust"),
      [
        "use probe::model::fixtures::features::defaults::DefaultsModel;",
        "",
        "#[test]",
        "fn literals_factory() {",
        "    let f = DefaultsModel::literals();",
        "    assert_eq!(f.singles, Some(vec![0.5f32, 2.0f32]));",
        "    assert_eq!(f.half_single, 0.25f32);",
        "    assert_eq!(f.large_exponent, 1e300);",
        "}",
        "",
      ].join("\n"),
    );
  });
});
