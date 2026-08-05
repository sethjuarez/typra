import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Model, ModelProperty } from "@typespec/compiler";

import { TypeRegistry } from "../src/ir/expansion.js";
import { TypeNode, PropertyNode } from "../src/ir/ast.js";
import { lowerFile } from "../src/ir/lower.js";
import { emitRustFile } from "../src/languages/rust/emitter.js";
import { RustExprVisitor } from "../src/languages/rust/visitor.js";

interface PropOptions {
  isScalar?: boolean;
  defaultValue?: string | null;
  allowedValues?: string[];
  isOpenEnum?: boolean;
}

function makeProp(name: string, typeName: string, options: PropOptions = {}): PropertyNode {
  const prop = new PropertyNode({} as ModelProperty, `Test ${name}`);
  prop.name = name;
  prop.typeName = { namespace: "Test", name: typeName };
  prop.isScalar = options.isScalar ?? false;
  prop.defaultValue = options.defaultValue ?? null;
  prop.allowedValues = options.allowedValues ?? [];
  prop.isOpenEnum = options.isOpenEnum ?? false;
  return prop;
}

interface TypeOptions {
  discriminator?: string;
  childTypes?: TypeNode[];
  isAbstract?: boolean;
  base?: { namespace: string; name: string } | null;
}

function makeType(name: string, properties: PropertyNode[], options: TypeOptions = {}): TypeNode {
  const node = new TypeNode({} as Model, `Test ${name}`);
  node.typeName = { namespace: "Test", name };
  node.properties = properties;
  node.discriminator = options.discriminator;
  node.childTypes = options.childTypes ?? [];
  node.factories = [];
  node.coercions = [];
  node.isAbstract = options.isAbstract ?? false;
  node.base = options.base ?? null;
  node.methods = [];
  return node;
}

/**
 * Builds an open polymorphic base whose discriminator is declared as a *named union*
 * (`alias ConnectionType = "reference" | "key" | string`), which is how an open
 * discriminator is most naturally spelled in TypeSpec.
 */
function emitOpenDiscriminatorBase(extraBaseProps: PropertyNode[] = []): string {
  const reference = makeType(
    "ReferenceConnection",
    [makeProp("kind", "string", { isScalar: true, defaultValue: "reference" })],
    { base: { namespace: "Test", name: "Conn" } },
  );
  const key = makeType(
    "KeyConnection",
    [makeProp("kind", "string", { isScalar: true, defaultValue: "key" })],
    { base: { namespace: "Test", name: "Conn" } },
  );
  const base = makeType(
    "Conn",
    [
      makeProp("kind", "ConnectionType", { allowedValues: ["reference", "key"], isOpenEnum: true }),
      ...extraBaseProps,
    ],
    { discriminator: "kind", childTypes: [reference, key], isAbstract: true },
  );

  const registry = TypeRegistry.fromTypeGraph([base, reference, key]);
  const polymorphic = new Set(["Conn"]);
  return emitRustFile(lowerFile(base, registry, polymorphic), new RustExprVisitor(registry), polymorphic);
}

describe("rust emitter — open polymorphic discriminators", () => {
  it("does not validate the discriminator field against its declared union type", () => {
    const code = emitOpenDiscriminatorBase();

    // The dispatch owns the discriminator: `validate_discriminator()` when closed, and the
    // `Unknown` fallback arm when open. Validating it *again* as an ordinary field checks it
    // against `ConnectionType`, whose declared variants are only "reference" | "key" — so an
    // unknown kind is rejected before dispatch and the open fallback arm becomes dead code.
    assert.ok(
      !/ConnectionType::validate_input_at/.test(code),
      "open discriminator must not be pre-validated against its declared union type",
    );

    // The fallback arm the pre-validation would have made unreachable.
    assert.ok(/Unknown \{/.test(code), "open dispatch must emit an Unknown fallback variant");
    assert.ok(
      /raw: serde_json::Map/.test(code),
      "Unknown fallback must retain the raw payload so undeclared keys survive a roundtrip",
    );
  });

  it("still validates non-discriminator fields that have a named complex type", () => {
    const code = emitOpenDiscriminatorBase([makeProp("auth", "AuthMode")]);

    // Guard against over-broad removal: excluding the discriminator must not disable input
    // validation for every other complex field on the same type.
    assert.ok(
      /AuthMode::validate_input_at/.test(code),
      "non-discriminator complex fields must still be input-validated",
    );
    assert.ok(
      !/ConnectionType::validate_input_at/.test(code),
      "the discriminator must remain exempt even when sibling complex fields are validated",
    );
  });
});
