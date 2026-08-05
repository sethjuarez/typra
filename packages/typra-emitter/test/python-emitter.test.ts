import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { FieldDecl, FileDecl, TypeDecl } from "../src/ir/declarations.js";
import { emitPythonFile } from "../src/languages/python/emitter.js";
import { PythonExprVisitor } from "../src/languages/python/visitor.js";

function field(
  name: string,
  category: FieldDecl["category"],
  isOptional: boolean,
  hasExplicitDefault = false,
): FieldDecl {
  const typeName = category.kind === "collection_complex"
    ? category.typeName
    : category.kind === "collection_scalar"
      ? category.scalarType
      : "unknown";
  return {
    name,
    typeName: { namespace: "Test", name: typeName },
    category,
    isOptional,
    defaultValue: null,
    hasExplicitDefault,
    allowedValues: [],
    parseAliases: {},
    enumName: null,
    isOpenEnum: false,
    description: "",
    knownAs: {},
  };
}

function typeDecl(fields: FieldDecl[]): TypeDecl {
  return {
    typeName: { namespace: "Test", name: "ModelInfo" },
    base: null,
    isAbstract: false,
    isProtocol: false,
    description: "",
    fields,
    coercionProperty: null,
    load: {
      coercions: [],
      assignments: fields.map(item => ({
        sourceName: item.name,
        fieldName: item.name,
        category: item.category,
        isOptional: item.isOptional,
        parentTypeName: "ModelInfo",
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
      assignments: fields.map(item => ({
        targetName: item.name,
        fieldName: item.name,
        category: item.category,
        isOptional: item.isOptional,
        parentTypeName: "ModelInfo",
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
}

function fileDecl(type: TypeDecl): FileDecl {
  return {
    typeName: type.typeName,
    types: [type],
    imports: [],
    containsAbstract: false,
    enums: [],
    group: "",
  };
}

describe("Python optional collection defaults", () => {
  it("preserves omitted optional collections while accepting explicit empty lists", () => {
    const type = typeDecl([
      field("inputModalities", { kind: "collection_scalar", scalarType: "string" }, true),
      field("owners", { kind: "collection_complex", typeName: "Owner" }, true),
      field("outputModalities", { kind: "collection_scalar", scalarType: "string" }, true, true),
      field("defaultOwners", { kind: "collection_complex", typeName: "Owner" }, true, true),
      field("requiredTags", { kind: "collection_scalar", scalarType: "string" }, false),
    ]);

    const source = emitPythonFile(fileDecl(type), new PythonExprVisitor());

    assert.match(source, /input_modalities: list\[str\] \| None = None/);
    assert.match(source, /owners: list\[Owner\] \| None = None/);
    assert.match(source, /output_modalities: list\[str\] \| None = field\(default_factory=list\)/);
    assert.match(source, /default_owners: list\[Owner\] \| None = field\(default_factory=list\)/);
    assert.match(source, /required_tags: list\[str\] = field\(default_factory=list\)/);
    assert.match(source, /if data is not None and "inputModalities" in data:\s+instance\.input_modalities = data\["inputModalities"\]/);
    assert.match(source, /if obj\.input_modalities is not None:\s+result\["inputModalities"\] = obj\.input_modalities/);
  });
});
