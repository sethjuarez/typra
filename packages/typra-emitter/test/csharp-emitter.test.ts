import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TypeDecl } from "../src/ir/declarations.js";
import { emitCSharpClass } from "../src/languages/csharp/emitter.js";
import { CSharpExprVisitor } from "../src/languages/csharp/visitor.js";

describe("C# emitter guarded scalar loads", () => {
  it("does not emit redundant null-conditional ToString calls", () => {
    const category = { kind: "scalar" as const, scalarType: "string" };
    const model: TypeDecl = {
      typeName: { namespace: "Test", name: "FailureChunk" },
      base: null,
      isAbstract: false,
      isProtocol: false,
      description: "",
      fields: [{
        name: "message",
        typeName: { namespace: "", name: "string" },
        category,
        isOptional: false,
        defaultValue: null,
        allowedValues: [],
        parseAliases: {},
        enumName: null,
        isOpenEnum: false,
        description: "",
        knownAs: {},
      }],
      coercionProperty: null,
      load: {
        coercions: [],
        assignments: [{
          sourceName: "message",
          fieldName: "message",
          category,
          isOptional: false,
          parentTypeName: "FailureChunk",
          enumName: null,
          allowedValues: [],
          parseAliases: {},
          defaultValue: null,
          isOpenEnum: false,
        }],
        hasPolymorphicDispatch: false,
        hasContextHooks: true,
      },
      save: {
        assignments: [{
          targetName: "message",
          fieldName: "message",
          category,
          isOptional: false,
          parentTypeName: "FailureChunk",
          enumName: null,
          isOpenEnum: false,
        }],
        hasBase: false,
        hasContextHooks: true,
      },
      factories: [],
      collectionHelpers: [],
      polymorphicDispatch: null,
      methods: [],
      wire: null,
    };

    const source = emitCSharpClass(
      model,
      "Test",
      new CSharpExprVisitor(),
      [model],
      () => undefined,
    );

    assert.match(source, /messageValue is not null/);
    assert.match(source, /instance\.Message = messageValue\.ToString\(\)!;/);
    assert.doesNotMatch(source, /messageValue\?\.ToString/);
  });

  it("permits null values in dictionary fields and initializers", () => {
    const category = { kind: "dict" as const };
    const field = {
      name: "metadata",
      typeName: { namespace: "", name: "Record<unknown>" },
      category,
      isOptional: false,
      defaultValue: null,
      allowedValues: [],
      parseAliases: {},
      enumName: null,
      isOpenEnum: false,
      description: "",
      knownAs: {},
    };
    const optionalField = {
      ...field,
      name: "optionalMetadata",
      isOptional: true,
    };
    const typedField = {
      ...field,
      name: "owners",
      typeName: { namespace: "Test", name: "Record<FixtureOwner>" },
      category: { kind: "dict" as const, valueType: "FixtureOwner" },
    };
    const model: TypeDecl = {
      typeName: { namespace: "Test", name: "Envelope" },
      base: null,
      isAbstract: false,
      isProtocol: false,
      description: "",
      fields: [field, optionalField, typedField],
      coercionProperty: null,
      load: {
        coercions: [],
        assignments: [field, optionalField, typedField].map(item => ({
          sourceName: item.name,
          fieldName: item.name,
          category: item.category,
          isOptional: item.isOptional,
          parentTypeName: "Envelope",
          enumName: null,
          allowedValues: [],
          parseAliases: {},
          defaultValue: null,
          isOpenEnum: false,
        })),
        hasPolymorphicDispatch: false,
        hasContextHooks: true,
      },
      save: {
        assignments: [field, optionalField, typedField].map(item => ({
          targetName: item.name,
          fieldName: item.name,
          category: item.category,
          isOptional: item.isOptional,
          parentTypeName: "Envelope",
          enumName: null,
          isOpenEnum: false,
        })),
        hasBase: false,
        hasContextHooks: true,
      },
      factories: [],
      collectionHelpers: [],
      polymorphicDispatch: null,
      methods: [],
      wire: null,
    };

    const source = emitCSharpClass(
      model,
      "Test",
      new CSharpExprVisitor(),
      [model],
      () => undefined,
    );

    assert.match(source, /#nullable disable annotations\n    \[global::System\.Diagnostics\.CodeAnalysis\.NotNull, global::System\.Diagnostics\.CodeAnalysis\.DisallowNull\]\n    public IDictionary<string, object> Metadata \{ get; set; \} = new Dictionary<string, object>\(\);\n#nullable restore annotations/);
    assert.match(source, /#nullable disable annotations\n    \[global::System\.Diagnostics\.CodeAnalysis\.MaybeNull, global::System\.Diagnostics\.CodeAnalysis\.AllowNull\]\n    public IDictionary<string, object> OptionalMetadata \{ get; set; \}\n#nullable restore annotations/);
    assert.match(source, /public IDictionary<string, FixtureOwner> Owners \{ get; set; \} = new Dictionary<string, FixtureOwner>\(\);/);
    assert.doesNotMatch(source, /CodeAnalysis\.(?:NotNull|MaybeNull)[^\n]*\n    public IDictionary<string, FixtureOwner>/);
    assert.doesNotMatch(source, /public IDictionary<string, object\?>/);
  });
});
