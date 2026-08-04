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

  it("emits nullable values only for Record<unknown> dictionaries", () => {
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

    assert.match(source, /public IDictionary<string, object\?> Metadata \{ get; set; \} = new Dictionary<string, object\?>\(\);/);
    assert.match(source, /public IDictionary<string, object\?>\? OptionalMetadata \{ get; set; \}/);
    assert.match(source, /public IDictionary<string, FixtureOwner> Owners \{ get; set; \} = new Dictionary<string, FixtureOwner>\(\);/);
    assert.doesNotMatch(source, /IDictionary<string, FixtureOwner\?>/);
  });

  it("emits nullable Record<unknown> values in protocol parameters", () => {
    const protocol: TypeDecl = {
      typeName: { namespace: "Test", name: "CheckpointStore" },
      base: null,
      isAbstract: false,
      isProtocol: true,
      description: "",
      fields: [],
      coercionProperty: null,
      load: {
        coercions: [],
        assignments: [],
        hasPolymorphicDispatch: false,
        hasContextHooks: false,
      },
      save: {
        assignments: [],
        hasBase: false,
        hasContextHooks: false,
      },
      factories: [],
      collectionHelpers: [],
      polymorphicDispatch: null,
      methods: [{
        name: "save",
        returns: "void",
        description: "",
        params: {
          requiredState: "Record<unknown>",
          optionalState: "Record<unknown>?",
        },
        optional: false,
        sync: true,
      }],
      wire: null,
    };

    const source = emitCSharpClass(
      protocol,
      "Test",
      new CSharpExprVisitor(),
      [protocol],
      () => undefined,
    );

    assert.match(source, /void Save\(Dictionary<string, object\?> requiredState, Dictionary<string, object\?>\? optionalState\);/);
    assert.doesNotMatch(source, /#nullable disable annotations|IDictionary<string, object>/);
  });
});
