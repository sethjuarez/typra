import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TypeNode } from "../src/ir/ast.js";
import { isCSharpAssertableSampleKey } from "../src/languages/csharp/driver.js";

const nodeWith = (properties: any[]): TypeNode =>
  ({
    typeName: { namespace: "Fixtures", name: "N" },
    properties,
  }) as unknown as TypeNode;

describe("C# generated conversion-test validations", () => {
  it("asserts scalar and enum properties declared on the node", () => {
    const node = nodeWith([
      { name: "kind", isScalar: true },
      { name: "mode", isScalar: false, enumName: "FixtureMode" },
    ]);

    assert.equal(isCSharpAssertableSampleKey("kind", "custom", node), true);
    assert.equal(isCSharpAssertableSampleKey("mode", "fast", node), true);
  });

  it("skips sample keys that are not properties of the emitted class", () => {
    // A polymorphic base carries a subtype-shaped @sample; `endpoint` lives on the subtype,
    // so asserting instance.Endpoint on the base does not compile (CS1061).
    const base = nodeWith([{ name: "kind", isScalar: true }]);

    assert.equal(
      isCSharpAssertableSampleKey("endpoint", "https://example.test", base),
      false,
    );
  });

  it("skips complex properties populated through a scalar coercion", () => {
    // `reference` is a complex FixtureReference reached via @coerce from a string. Comparing
    // the scalar sample to the complex property resolves to the wrong overload (CS1503).
    const node = nodeWith([{ name: "reference", isScalar: false }]);

    assert.equal(
      isCSharpAssertableSampleKey("reference", "ref-shortcut", node),
      false,
    );
  });
});
