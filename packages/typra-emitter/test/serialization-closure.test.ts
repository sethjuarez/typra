import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Model, ModelProperty } from "@typespec/compiler";

import { TypeNode, PropertyNode } from "../src/ir/ast.js";
import { TypeRegistry } from "../src/ir/expansion.js";
import { computeSerializationClosure } from "../src/ir/lower.js";
import type { SerializationDirection } from "../src/decorators.js";

/**
 * Serialization-closure lock — Track B, stage 2 (issue #306).
 *
 * `@serializable` is opt-in: only annotated roots seed the closure, which then
 * grows by transitive property reachability + discriminated variant expansion.
 * `@sensitive` withholding from BOTH directions removes a field's reachability.
 * These assertions pin that derivation independently of any target language.
 */

function makeProp(
  name: string,
  typeName: string,
  ref?: TypeNode,
  sensitive: SerializationDirection[] = [],
): PropertyNode {
  const prop = new PropertyNode({} as ModelProperty, `Test ${name}`);
  prop.name = name;
  prop.typeName = { namespace: "Test", name: typeName };
  prop.type = ref;
  prop.sensitive = sensitive;
  return prop;
}

/** A `Record<Value>` property: no `.type`, element name in `dictValueType`. */
function makeDictProp(name: string, valueTypeName: string): PropertyNode {
  const prop = new PropertyNode({} as ModelProperty, `Test ${name}`);
  prop.name = name;
  prop.typeName = { namespace: "", name: "dictionary" };
  prop.type = undefined;
  prop.isDict = true;
  prop.isCollection = true;
  prop.dictValueType = valueTypeName;
  return prop;
}

function makeType(
  name: string,
  properties: PropertyNode[],
  opts: {
    serializable?: boolean;
    discriminator?: string;
    base?: string;
  } = {},
): TypeNode {
  const node = new TypeNode({} as Model, `Test ${name}`);
  node.typeName = { namespace: "Test", name };
  node.properties = properties;
  node.childTypes = [];
  node.serializable = opts.serializable ?? false;
  node.discriminator = opts.discriminator;
  node.base = opts.base ? { namespace: "Test", name: opts.base } : null;
  return node;
}

describe("computeSerializationClosure", () => {
  it("returns an empty closure when no root is @serializable", () => {
    const leaf = makeType("Leaf", []);
    const root = makeType("Root", [makeProp("leaf", "Leaf", leaf)]);
    const registry = TypeRegistry.fromTypeGraph([root, leaf]);

    const closure = computeSerializationClosure([root, leaf], registry);

    assert.equal(closure.size, 0);
  });

  it("pulls the transitive property reach of a @serializable root", () => {
    const inner = makeType("Inner", []);
    const profile = makeType("Profile", [makeProp("inner", "Inner", inner)]);
    const root = makeType(
      "Root",
      [
        makeProp("name", "string"),
        makeProp("profile", "Profile", profile),
      ],
      { serializable: true },
    );
    const nodes = [root, profile, inner];
    const registry = TypeRegistry.fromTypeGraph(nodes);

    const closure = computeSerializationClosure(nodes, registry);

    assert.deepEqual([...closure].sort(), ["Inner", "Profile", "Root"]);
  });

  it("expands every discriminated variant so polymorphic load stays total", () => {
    const textPart = makeType("TextPart", [makeProp("text", "string")]);
    const imagePart = makeType("ImagePart", [makeProp("url", "string")]);
    const contentPart = makeType("ContentPart", [], {
      discriminator: "kind",
    });
    contentPart.childTypes = [textPart, imagePart];
    const root = makeType(
      "Message",
      [makeProp("parts", "ContentPart", contentPart)],
      { serializable: true },
    );
    const nodes = [root, contentPart, textPart, imagePart];
    const registry = TypeRegistry.fromTypeGraph(nodes);

    const closure = computeSerializationClosure(nodes, registry);

    assert.deepEqual(
      [...closure].sort(),
      ["ContentPart", "ImagePart", "Message", "TextPart"],
    );
  });

  it("drops a type reached only through a fully-withheld @sensitive field", () => {
    const secretShape = makeType("SecretShape", []);
    const root = makeType(
      "Root",
      [makeProp("secret", "SecretShape", secretShape, ["load", "save"])],
      { serializable: true },
    );
    const nodes = [root, secretShape];
    const registry = TypeRegistry.fromTypeGraph(nodes);

    const closure = computeSerializationClosure(nodes, registry);

    assert.deepEqual([...closure].sort(), ["Root"]);
  });

  it("keeps a type reached through a partially-withheld @sensitive field", () => {
    const shape = makeType("WriteOnlyShape", []);
    const root = makeType(
      "Root",
      [makeProp("token", "WriteOnlyShape", shape, ["save"])],
      { serializable: true },
    );
    const nodes = [root, shape];
    const registry = TypeRegistry.fromTypeGraph(nodes);

    const closure = computeSerializationClosure(nodes, registry);

    assert.deepEqual([...closure].sort(), ["Root", "WriteOnlyShape"]);
  });

  it("closes the .type cycle-prevention gap via the registry", () => {
    // Two roots reference the same element type; only the first occurrence
    // carries `.type` (mirrors resolveModel cycle prevention). The second root
    // must still reach the shared element through the registry.
    const element = makeType("Element", [makeProp("id", "string")]);
    const rootA = makeType("RootA", [makeProp("el", "Element", element)]);
    const rootB = makeType(
      "RootB",
      [makeProp("el", "Element", undefined)], // .type gap
      { serializable: true },
    );
    const nodes = [rootA, rootB, element];
    const registry = TypeRegistry.fromTypeGraph(nodes);

    const closure = computeSerializationClosure(nodes, registry);

    assert.deepEqual([...closure].sort(), ["Element", "RootB"]);
  });

  it("is cycle-safe for self-referential shapes", () => {
    const node = makeType("Tree", [], { serializable: true });
    node.properties = [makeProp("parent", "Tree", node)];
    const nodes = [node];
    const registry = TypeRegistry.fromTypeGraph(nodes);

    const closure = computeSerializationClosure(nodes, registry);

    assert.deepEqual([...closure], ["Tree"]);
  });

  it("traverses dictionary (Record) value models", () => {
    const child = makeType("Child", [makeProp("value", "string")]);
    const root = makeType("Root", [makeDictProp("children", "Child")], {
      serializable: true,
    });
    const nodes = [root, child];
    const registry = TypeRegistry.fromTypeGraph(nodes);

    const closure = computeSerializationClosure(nodes, registry);

    assert.deepEqual([...closure].sort(), ["Child", "Root"]);
  });

  it("reaches the base of a directly-@serializable derived model", () => {
    const base = makeType("Base", [makeProp("id", "string")]);
    const derived = makeType("Derived", [makeProp("value", "string")], {
      serializable: true,
      base: "Base",
    });
    const nodes = [base, derived];
    const registry = TypeRegistry.fromTypeGraph(nodes);

    const closure = computeSerializationClosure(nodes, registry);

    assert.deepEqual([...closure].sort(), ["Base", "Derived"]);
  });

  it("does NOT pull plain (non-discriminated) subclasses into the closure", () => {
    // A non-discriminated base carries its `extends` subclasses in childTypes,
    // but they are not part of polymorphic serialization and must stay out
    // unless referenced.
    const base = makeType("Base", [makeProp("id", "string")], {
      serializable: true,
    });
    const internalDerived = makeType("InternalDerived", [], { base: "Base" });
    base.childTypes = [internalDerived];
    const nodes = [base, internalDerived];
    const registry = TypeRegistry.fromTypeGraph(nodes);

    const closure = computeSerializationClosure(nodes, registry);

    assert.deepEqual([...closure], ["Base"]);
  });
});
