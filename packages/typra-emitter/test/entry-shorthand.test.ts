import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Model, ModelProperty } from "@typespec/compiler";

import { TypeRegistry } from "../src/ir/expansion.js";
import { TypeNode, PropertyNode } from "../src/ir/ast.js";
import { lowerFile } from "../src/ir/lower.js";
import { emitGoFileContent } from "../src/languages/go/emitter.js";
import { GoExprVisitor } from "../src/languages/go/visitor.js";
import { emitTypeScriptFile } from "../src/languages/typescript/emitter.js";
import { TypeScriptExprVisitor } from "../src/languages/typescript/visitor.js";
import { emitPythonFile } from "../src/languages/python/emitter.js";
import { PythonExprVisitor } from "../src/languages/python/visitor.js";
import { emitCSharpClass } from "../src/languages/csharp/emitter.js";
import { CSharpExprVisitor } from "../src/languages/csharp/visitor.js";
import { emitJavaFileContent } from "../src/languages/java/emitter.js";
import { JavaExprVisitor } from "../src/languages/java/visitor.js";

/**
 * Cross-backend lock for `@entryShorthand` — issue #76.
 *
 * `spec/vectors/model/named_collection_vectors.json` states the contract:
 *
 *   "Immediate primitive Property values infer kind and default without leaking
 *    direct-coercion example semantics."
 *
 * The contract is language-independent, so it is asserted here in one place
 * rather than four. The defect it guards against is that a bare scalar under a
 * name key was expanded *positionally* into the element's first declared field.
 * For a discriminated element that field is the discriminator, so
 * `inputs: { city: "Seattle" }` loaded as `kind: "Seattle"` — a value the
 * element's own validator rejects.
 *
 * Rust's arm-level assertions live in `rust-emitter.test.ts`; this file checks
 * that every other backend reaches the same three conclusions.
 */

function makeProp(
  name: string,
  typeName: string,
  isScalar = false,
): PropertyNode {
  const prop = new PropertyNode({} as ModelProperty, `Test ${name}`);
  prop.name = name;
  prop.typeName = { namespace: "Test", name: typeName };
  prop.isScalar = isScalar;
  prop.defaultValue = null;
  prop.allowedValues = [];
  prop.isOpenEnum = false;
  return prop;
}

function makeType(name: string, properties: PropertyNode[]): TypeNode {
  const node = new TypeNode({} as Model, `Test ${name}`);
  node.typeName = { namespace: "Test", name };
  node.properties = properties;
  node.childTypes = [];
  node.factories = [];
  node.coercions = [];
  node.isAbstract = false;
  node.base = null;
  node.methods = [];
  return node;
}

/**
 * `Prompty { inputs: Property[] }` in name-keyed form, with prompty's real
 * coercion table. `kind` is declared first precisely because that is what made
 * the positional fallback unsound.
 */
function buildGraph(
  entryShorthand: string | null,
  literalExtras: Record<string, unknown> = {},
) {
  const extraFields = Object.keys(literalExtras);
  const element = makeType("Property", [
    makeProp("name", "string", true),
    makeProp("kind", "string", true),
    makeProp("default", "unknown", true),
    makeProp("example", "unknown", true),
    ...extraFields.map((f) => makeProp(f, "unknown", true)),
  ]);
  element.discriminator = "kind";
  element.coercions = [
    {
      scalar: "string",
      expansion: { kind: "string", ...literalExtras, example: "{value}" },
    },
    {
      scalar: "integer",
      expansion: { kind: "integer", ...literalExtras, example: "{value}" },
    },
    {
      scalar: "float32",
      expansion: { kind: "float", ...literalExtras, example: "{value}" },
    },
    {
      scalar: "boolean",
      expansion: { kind: "boolean", ...literalExtras, example: "{value}" },
    },
  ] as unknown as typeof element.coercions;
  element.entryShorthand = entryShorthand;

  const inputs = makeProp("inputs", "Property");
  inputs.isCollection = true;
  inputs.isNamedCollection = true;
  inputs.type = element;

  const owner = makeType("Prompty", [inputs]);
  const registry = TypeRegistry.fromTypeGraph([owner, element]);
  return { owner, element, registry };
}

/** Non-string coercion constants used to lock literal-type preservation. */
const LITERAL_EXTRAS = { nullable: true, ordinal: 2 };

function emitGo(
  entryShorthand: string | null,
  extras?: Record<string, unknown>,
): string {
  const { owner, registry } = buildGraph(entryShorthand, extras);
  const ownerDecl = lowerFile(owner, registry, new Set<string>()).types[0];
  return emitGoFileContent(
    [ownerDecl],
    "model",
    new GoExprVisitor(registry),
    new Set<string>(),
  );
}

function emitTs(
  entryShorthand: string | null,
  extras?: Record<string, unknown>,
): string {
  const { owner, registry } = buildGraph(entryShorthand, extras);
  return emitTypeScriptFile(
    lowerFile(owner, registry, new Set<string>()),
    new TypeScriptExprVisitor(registry),
  );
}

function emitPy(
  entryShorthand: string | null,
  extras?: Record<string, unknown>,
): string {
  const { owner, registry } = buildGraph(entryShorthand, extras);
  return emitPythonFile(
    lowerFile(owner, registry, new Set<string>()),
    new PythonExprVisitor(registry),
  );
}

function emitCs(
  entryShorthand: string | null,
  extras?: Record<string, unknown>,
): string {
  const { owner, element, registry } = buildGraph(entryShorthand, extras);
  const ownerDecl = lowerFile(owner, registry, new Set<string>()).types[0];
  const elementDecl = lowerFile(element, registry, new Set<string>()).types[0];
  const all = [ownerDecl, elementDecl];
  return emitCSharpClass(
    ownerDecl,
    "Test",
    new CSharpExprVisitor(registry),
    all,
    (name) => all.find((t) => t.typeName.name === name),
  );
}

function emitJava(
  entryShorthand: string | null,
  extras?: Record<string, unknown>,
): string {
  const { owner, registry } = buildGraph(entryShorthand, extras);
  const ownerDecl = lowerFile(owner, registry, new Set<string>()).types[0];
  return emitJavaFileContent(
    [ownerDecl],
    "test",
    new JavaExprVisitor(registry),
    new Set<string>(),
  );
}

const backends: Array<{
  name: string;
  emit: (
    entryShorthand: string | null,
    extras?: Record<string, unknown>,
  ) => string;
  /** Matches the emitted assignment of the inferred discriminator for a string entry. */
  stringArm: RegExp;
  /** Matches the emitted assignment of the inferred discriminator for an integer entry. */
  integerArm: RegExp;
  /** The integral runtime check, which must precede the fractional one. */
  integralCheck: RegExp;
  /** The fractional runtime check. */
  fractionalCheck: RegExp;
  /** A boolean coercion constant rendered in this language's native syntax. */
  booleanLiteral: RegExp;
  /** A numeric coercion constant rendered unquoted. */
  numericLiteral: RegExp;
}> = [
  {
    name: "go",
    emit: emitGo,
    stringArm: /item\["kind"\] = "string"/,
    integerArm: /item\["kind"\] = "integer"/,
    integralCheck: /case int, int32, int64:/,
    fractionalCheck: /case float64:/,
    booleanLiteral: /item\["nullable"\] = true$/m,
    numericLiteral: /item\["ordinal"\] = 2$/m,
  },
  {
    name: "typescript",
    emit: emitTs,
    stringArm: /"kind": "string", "default": v/,
    integerArm: /"kind": "integer", "default": v/,
    integralCheck: /Number\.isInteger\(v\)/,
    fractionalCheck: /\(typeof v === "number"\) \{/,
    booleanLiteral: /"nullable": true,/,
    numericLiteral: /"ordinal": 2,/,
  },
  {
    name: "python",
    emit: emitPy,
    stringArm: /\{"kind": "string", "default": v\}/,
    integerArm: /\{"kind": "integer", "default": v\}/,
    integralCheck: /isinstance\(v, int\) and not isinstance\(v, bool\)/,
    fractionalCheck: /isinstance\(v, float\)/,
    booleanLiteral: /"nullable": True,/,
    numericLiteral: /"ordinal": 2,/,
  },
  {
    name: "csharp",
    emit: emitCs,
    stringArm: /newDict\["kind"\] = "string"/,
    integerArm: /newDict\["kind"\] = "integer"/,
    integralCheck: /kvp\.Value is int or long or short or byte/,
    fractionalCheck: /kvp\.Value is double or float or decimal/,
    booleanLiteral: /newDict\["nullable"\] = true;/,
    numericLiteral: /newDict\["ordinal"\] = 2;/,
  },
  {
    name: "java",
    emit: emitJava,
    stringArm: /itemData\.put\("kind", "string"\)/,
    integerArm: /itemData\.put\("kind", "integer"\)/,
    integralCheck:
      /shorthandValue instanceof Integer \|\| shorthandValue instanceof Long/,
    fractionalCheck:
      /shorthandValue instanceof Double \|\| shorthandValue instanceof Float/,
    booleanLiteral: /itemData\.put\("nullable", true\)/,
    numericLiteral: /itemData\.put\("ordinal", 2\)/,
  },
];

describe("named-collection entry shorthand — cross-backend", () => {
  for (const backend of backends) {
    describe(backend.name, () => {
      it("infers the discriminator from the coercion table", () => {
        const code = backend.emit("default");

        assert.match(
          code,
          backend.stringArm,
          'a string entry must infer kind "string"',
        );
        assert.match(
          code,
          backend.integerArm,
          'an integer entry must infer kind "integer"',
        );
      });

      it("does not leak direct-coercion example semantics", () => {
        const code = backend.emit("default");

        assert.ok(
          !/"example"\]?\s*[:=]\s*(v\b|value\b|kvp\.Value|shorthandValue)/.test(
            code,
          ),
          "the entry shorthand populates the declared field, never the coercion target",
        );
      });

      it("classifies integers before floats", () => {
        const code = backend.emit("default");

        const integral = code.search(backend.integralCheck);
        const fractional = code.search(backend.fractionalCheck);
        assert.ok(integral !== -1, "expected an integral entry arm");
        assert.ok(fractional !== -1, "expected a fractional entry arm");
        assert.ok(
          integral < fractional,
          "the integral check must precede the fractional one or every integer collapses into a float",
        );
      });

      it("emits no inference arms when the declaration is absent", () => {
        const code = backend.emit(null);

        assert.ok(
          !backend.stringArm.test(code) && !backend.integerArm.test(code),
          "an undeclared schema must keep its historical single-field shorthand",
        );
      });

      it("preserves the declared type of non-string coercion constants", () => {
        const code = backend.emit("default", LITERAL_EXTRAS);

        assert.match(
          code,
          backend.booleanLiteral,
          'a boolean coercion constant must emit as a native boolean, not the string "true"',
        );
        assert.match(
          code,
          backend.numericLiteral,
          "a numeric coercion constant must emit unquoted",
        );
        assert.ok(
          !/nullable"\]?\s*[:=]\s*"(true|True)"/.test(code) &&
            !/ordinal"\]?\s*[:=]\s*"2"/.test(code),
          "stringifying every constant retypes any schema that expands into a non-string value",
        );
      });
    });
  }
});
