import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as ts from "typescript";

import type { FieldDecl, FileDecl, TypeDecl } from "../src/ir/declarations.js";
import { emitTypeScriptFile } from "../src/languages/typescript/emitter.js";
import { TypeScriptExprVisitor } from "../src/languages/typescript/visitor.js";

function field(
  name: string,
  category: FieldDecl["category"],
  isOptional: boolean,
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
    typeName: { namespace: "Test", name: "CollectionModel" },
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
        parentTypeName: "CollectionModel",
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
        parentTypeName: "CollectionModel",
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

interface GeneratedCollectionModel {
  inputModalities?: string[];
  outputModalities?: string[];
  requiredTags: string[];
  save(): Record<string, unknown>;
}

interface GeneratedCollectionModelConstructor {
  new(init?: Partial<GeneratedCollectionModel>): GeneratedCollectionModel;
  load(data: Record<string, unknown>): GeneratedCollectionModel;
}

function evaluateCollectionModel(source: string): GeneratedCollectionModelConstructor {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      useDefineForClassFields: true,
    },
  }).outputText;
  const exports: Record<string, unknown> = {};
  const loadContext = class {};
  const saveContext = class {};
  const requireModule = (name: string): unknown => {
    if (name === "./context") {
      return { LoadContext: loadContext, SaveContext: saveContext };
    }
    throw new Error(`Unexpected generated import: ${name}`);
  };
  const execute = new Function("exports", "require", output);
  execute(exports, requireModule);
  assert.equal(typeof exports.CollectionModel, "function");
  return exports.CollectionModel as GeneratedCollectionModelConstructor;
}

describe("TypeScript optional collection defaults", () => {
  it("preserves omitted optional collections while accepting explicit empty arrays", () => {
    const type = typeDecl([
      field("inputModalities", { kind: "collection_scalar", scalarType: "string" }, true),
      field("outputModalities", { kind: "collection_scalar", scalarType: "string" }, true),
      field("owners", { kind: "collection_complex", typeName: "Owner" }, true),
      field("requiredTags", { kind: "collection_scalar", scalarType: "string" }, false),
    ]);

    const source = emitTypeScriptFile(fileDecl(type), new TypeScriptExprVisitor());

    assert.match(source, /inputModalities\?: string\[\];/);
    assert.match(source, /outputModalities\?: string\[\];/);
    assert.match(source, /owners\?: Owner\[\];/);
    assert.doesNotMatch(source, /inputModalities\?: string\[\] = \[\];/);
    assert.doesNotMatch(source, /owners\?: Owner\[\] = \[\];/);
    assert.match(source, /requiredTags: string\[\] = \[\];/);

    assert.match(source, /if \(init\?\.inputModalities !== undefined\) \{\s+this\.inputModalities = init\.inputModalities;\s+\}/);
    assert.match(source, /if \(init\?\.owners !== undefined\) \{\s+this\.owners = init\.owners;\s+\}/);
    assert.match(source, /this\.requiredTags = init\?\.requiredTags \?\? \[\];/);

    assert.match(source, /if \(data\["inputModalities"\] !== undefined && data\["inputModalities"\] !== null\) \{\s+instance\.inputModalities = \(data\["inputModalities"\] as unknown\[\]\)\.map\(v => String\(v\)\);\s+\}/);
    assert.match(source, /if \(data\["owners"\] !== undefined && data\["owners"\] !== null\) \{\s+instance\.owners = CollectionModel\.loadOwners\(data\["owners"\] as unknown\[\], context\);\s+\}/);

    const CollectionModel = evaluateCollectionModel(source);
    const omitted = new CollectionModel();
    assert.equal(omitted.inputModalities, undefined);
    assert.equal(omitted.outputModalities, undefined);
    assert.deepEqual(omitted.save(), { requiredTags: [] });

    const explicit = new CollectionModel({ inputModalities: [], outputModalities: [] });
    assert.deepEqual(explicit.inputModalities, []);
    assert.deepEqual(explicit.outputModalities, []);
    assert.deepEqual(explicit.save(), { inputModalities: [], outputModalities: [], requiredTags: [] });

    assert.equal(CollectionModel.load({}).inputModalities, undefined);
    assert.deepEqual(CollectionModel.load({ inputModalities: [] }).inputModalities, []);
    assert.equal(CollectionModel.load({}).outputModalities, undefined);
    assert.deepEqual(CollectionModel.load({ outputModalities: [] }).outputModalities, []);
  });
});
