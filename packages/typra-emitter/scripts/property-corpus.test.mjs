import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildPropertyCorpus,
  shrinkPropertyDifference,
} from "./property-corpus.mjs";

function prop(name, typeName, options = {}) {
  return {
    name,
    typeName: { namespace: "Test", name: typeName },
    defaultValue: options.defaultValue ?? "null",
    allowedValues: options.allowedValues ?? [],
    isOpenEnum: options.isOpenEnum ?? false,
    isScalar: options.isScalar ?? false,
    isOptional: options.isOptional ?? false,
    isCollection: options.isCollection ?? false,
    isAny: options.isAny ?? false,
    isDict: options.isDict ?? false,
    isNamedCollection: options.isNamedCollection ?? false,
    dictValueType: options.dictValueType ?? null,
    type: options.type,
  };
}

function type(name, properties, options = {}) {
  return {
    typeName: { namespace: "Test", name },
    discriminator: options.discriminator,
    childTypes: options.childTypes ?? [],
    properties,
  };
}

describe("property corpus generator", () => {
  it("is deterministic for a fixed seed and case count", () => {
    const root = type("Root", [
      prop("name", "string", { isScalar: true }),
      prop("count", "int32", { isScalar: true }),
    ]);

    assert.deepEqual(
      buildPropertyCorpus(root, {
        rootType: "Root",
        seed: 0xabc,
        caseCount: 3,
      }),
      buildPropertyCorpus(root, {
        rootType: "Root",
        seed: 0xabc,
        caseCount: 3,
      }),
    );
  });

  it("preserves required keys while varying optional inclusion", () => {
    const root = type("Root", [
      prop("requiredName", "string", { isScalar: true }),
      prop("requiredItems", "string", { isScalar: true, isCollection: true }),
      prop("optionalName", "string", { isScalar: true, isOptional: true }),
    ]);

    for (const entry of buildPropertyCorpus(root, {
      rootType: "Root",
      seed: 0x117,
      caseCount: 4,
    })) {
      assert.ok("requiredName" in entry.input);
      assert.ok("requiredItems" in entry.input);
    }
  });

  it("bounds recursive graphs by depth without recursing forever", () => {
    const root = type("Tree", []);
    root.properties.push(
      prop("name", "string", { isScalar: true }),
      prop("children", "Tree", { isCollection: true, type: root }),
      prop("optionalChild", "Tree", { isOptional: true, type: root }),
    );

    const [entry] = buildPropertyCorpus(root, {
      rootType: "Tree",
      seed: 0x117,
      caseCount: 1,
      maxDepth: 2,
    });

    assert.deepEqual(entry.input.children, []);
    assert.equal(JSON.stringify(entry.input).includes("optionalChild"), false);
  });

  it("selects concrete discriminator variants and materializes wildcard values", () => {
    const text = type("TextContent", [
      prop("kind", "string", { isScalar: true, defaultValue: "text" }),
      prop("value", "string", { isScalar: true }),
    ]);
    const wildcard = type("WildcardContent", [
      prop("kind", "string", { isScalar: true, defaultValue: "*" }),
      prop("payload", "unknown", { isAny: true }),
    ]);
    const content = type(
      "Content",
      [prop("kind", "string", { isScalar: true, allowedValues: ["text"] })],
      { discriminator: "kind", childTypes: [text, wildcard] },
    );
    const root = type("Root", [prop("content", "Content", { type: content })]);

    const cases = buildPropertyCorpus(root, {
      rootType: "Root",
      seed: 0x117,
      caseCount: 6,
    });
    const kinds = cases.map((entry) => entry.input.content.kind);

    assert.ok(kinds.includes("text"));
    assert.ok(kinds.some((kind) => kind.startsWith("vendor-")));
  });

  it("keys renamed properties by their @encodedName wire key", () => {
    const root = type("Root", [
      {
        ...prop("fadeInMs", "int32", { isScalar: true }),
        serializedName: "fade_in_ms",
      },
    ]);
    const [entry] = buildPropertyCorpus(root, {
      rootType: "Root",
      seed: 0x117,
      caseCount: 1,
    });
    assert.ok("fade_in_ms" in entry.input);
    assert.equal("fadeInMs" in entry.input, false);
  });
  it("keeps required nullable keys present, sometimes as an explicit null", () => {
    const root = type("Root", [
      { ...prop("caption", "string", { isScalar: true }), isNullable: true },
    ]);
    const values = buildPropertyCorpus(root, {
      rootType: "Root",
      seed: 0x117,
      caseCount: 8,
    }).map((entry) => {
      assert.ok("caption" in entry.input, "required nullable key is always present");
      return entry.input.caption;
    });
    assert.ok(values.includes(null), "some case carries an explicit null");
    assert.ok(
      values.some((value) => typeof value === "string"),
      "some case carries a non-null value",
    );
  });
});

describe("property corpus shrink output", () => {
  it("finds the same first differing path deterministically", () => {
    const expected = {
      propertyCases: [
        {
          id: "root-0x117-case-000",
          seed: "0x117",
          caseId: "case-000",
          root: { name: "same", nested: { alpha: 1, beta: 2 } },
        },
      ],
    };
    const actual = {
      propertyCases: [
        {
          id: "root-0x117-case-000",
          seed: "0x117",
          caseId: "case-000",
          root: { name: "same", nested: { alpha: 1, beta: 3 } },
        },
      ],
    };

    assert.deepEqual(shrinkPropertyDifference(expected, actual), {
      id: "root-0x117-case-000",
      seed: "0x117",
      caseId: "case-000",
      path: "$.nested.beta",
      expected: 2,
      actual: 3,
    });
    assert.deepEqual(
      shrinkPropertyDifference(expected, actual),
      shrinkPropertyDifference(expected, actual),
    );
  });

  it("reports a dropped required nullable key instead of treating it as null", () => {
    const entry = { id: "root-0x117-case-007", seed: "0x117", caseId: "case-007" };
    const expected = {
      propertyCases: [
        { ...entry, root: { content: { kind: "audio", transcript: null } } },
      ],
    };
    const actual = {
      propertyCases: [{ ...entry, root: { content: { kind: "audio" } } }],
    };
    // The conformance gate compares JSON text, where a missing key and `"key": null` differ.
    assert.notEqual(JSON.stringify(expected), JSON.stringify(actual));
    const difference = shrinkPropertyDifference(expected, actual);
    assert.equal(difference.path, "$.content.transcript");
    assert.equal(difference.expected, null);
  });
});
