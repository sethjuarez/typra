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
  hasExplicitDefault = false,
): FieldDecl {
  const typeName =
    category.kind === "collection_complex"
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
    typeName: { namespace: "Test", name: "CollectionModel" },
    serialized: true,
    base: null,
    isAbstract: false,
    isProtocol: false,
    description: "",
    fields,
    coercionProperty: null,
    load: {
      coercions: [],
      assignments: fields.map((item) => ({
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
      assignments: fields.map((item) => ({
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
    collectionHelpers: fields
      .filter((item) => item.category.kind === "collection_complex")
      .map((item) => ({
        propertyName: item.name,
        elementTypeName: item.typeName,
        innerFields: [],
        hasNameProperty: false,
      })),
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

function fileDecls(types: TypeDecl[]): FileDecl {
  return {
    typeName: types[0].typeName,
    types,
    imports: [],
    containsAbstract: types.some((type) => type.isAbstract),
    enums: [],
    group: "",
  };
}

interface GeneratedCollectionModel {
  inputModalities?: string[];
  outputModalities?: string[];
  defaultOwners?: unknown[];
  requiredTags: string[];
  save(): Record<string, unknown>;
}

interface GeneratedCollectionModelConstructor {
  new (init?: Partial<GeneratedCollectionModel>): GeneratedCollectionModel;
  load(data: Record<string, unknown>): GeneratedCollectionModel;
}

function evaluateCollectionModel(
  source: string,
): GeneratedCollectionModelConstructor {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      useDefineForClassFields: true,
    },
  }).outputText;
  const exports: Record<string, unknown> = {};
  const loadContext = class {
    at(): this {
      return this;
    }
    processInput<T>(value: T): T {
      return value;
    }
    processOutput<T>(value: T): T {
      return value;
    }
  };
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
      field(
        "inputModalities",
        { kind: "collection_scalar", scalarType: "string" },
        true,
      ),
      field("owners", { kind: "collection_complex", typeName: "Owner" }, true),
      field(
        "outputModalities",
        { kind: "collection_scalar", scalarType: "string" },
        true,
        true,
      ),
      field(
        "defaultOwners",
        { kind: "collection_complex", typeName: "Owner" },
        true,
        true,
      ),
      field(
        "requiredTags",
        { kind: "collection_scalar", scalarType: "string" },
        false,
      ),
    ]);
    const source = emitTypeScriptFile(
      fileDecl(type),
      new TypeScriptExprVisitor(),
    );
    assert.match(source, /inputModalities\?: string\[\];/);
    assert.match(source, /owners\?: Owner\[\];/);
    assert.match(source, /outputModalities\?: string\[\] = \[\];/);
    assert.match(source, /defaultOwners\?: Owner\[\] = \[\];/);
    assert.doesNotMatch(source, /inputModalities\?: string\[\] = \[\];/);
    assert.doesNotMatch(source, /owners\?: Owner\[\] = \[\];/);
    assert.match(source, /requiredTags: string\[\] = \[\];/);

    assert.match(
      source,
      /if \(init\?\.inputModalities !== undefined\) \{\s+this\.inputModalities = init\.inputModalities;\s+\}/,
    );
    assert.match(
      source,
      /if \(init\?\.owners !== undefined\) \{\s+this\.owners = init\.owners;\s+\}/,
    );
    assert.match(
      source,
      /this\.requiredTags = init\?\.requiredTags \?\? \[\];/,
    );
    assert.match(
      source,
      /this\.outputModalities = init\?\.outputModalities \?\? \[\];/,
    );
    assert.match(
      source,
      /this\.defaultOwners = init\?\.defaultOwners \?\? \[\];/,
    );

    assert.match(
      source,
      /if \(data\["inputModalities"\] !== undefined && data\["inputModalities"\] !== null\) \{\s+instance\.inputModalities = \(data\["inputModalities"\] as unknown\[\]\)\.map\(v => String\(v\)\);\s+\}/,
    );
    assert.match(
      source,
      /if \(data\["owners"\] !== undefined && data\["owners"\] !== null\) \{\s+instance\.owners = CollectionModel\.loadOwners\(data\["owners"\] as unknown\[\], context\.at\("owners"\)\);\s+\}/,
    );

    const CollectionModel = evaluateCollectionModel(source);
    const omitted = new CollectionModel();
    assert.equal(omitted.inputModalities, undefined);
    assert.deepEqual(omitted.outputModalities, []);
    assert.deepEqual(omitted.defaultOwners, []);
    assert.deepEqual(omitted.save(), {
      outputModalities: [],
      defaultOwners: [],
      requiredTags: [],
    });

    const explicit = new CollectionModel({
      inputModalities: [],
      outputModalities: [],
    });
    assert.deepEqual(explicit.inputModalities, []);
    assert.deepEqual(explicit.outputModalities, []);
    assert.deepEqual(explicit.save(), {
      inputModalities: [],
      outputModalities: [],
      defaultOwners: [],
      requiredTags: [],
    });

    assert.equal(CollectionModel.load({}).inputModalities, undefined);
    assert.deepEqual(CollectionModel.load({}).outputModalities, []);
    assert.deepEqual(CollectionModel.load({}).defaultOwners, []);
    assert.deepEqual(
      CollectionModel.load({ inputModalities: [] }).inputModalities,
      [],
    );
    assert.deepEqual(
      CollectionModel.load({ outputModalities: [] }).outputModalities,
      [],
    );
  });
});

describe("TypeScript runtime neutrality", () => {
  it("parses YAML through LoadContext.parseYaml instead of a CommonJS require()", () => {
    const source = emitTypeScriptFile(
      fileDecl(
        typeDecl([
          field("name", { kind: "scalar", scalarType: "string" }, false),
        ]),
      ),
      new TypeScriptExprVisitor(),
    );

    assert.match(source, /static fromYaml\(/);
    assert.match(source, /const data = LoadContext\.parseYaml\(yaml\);/);
    // require() is undefined under native ESM and in the browser; the emitted
    // library must stay runtime-neutral and never bake in a CommonJS require.
    assert.doesNotMatch(source, /\brequire\s*\(/);
  });
});

describe("TypeScript native serialization option", () => {
  it("keeps the default TypeScript output free of Zod imports and schemas", () => {
    const source = emitTypeScriptFile(
      fileDecl(
        typeDecl([
          field("name", { kind: "scalar", scalarType: "string" }, false),
        ]),
      ),
      new TypeScriptExprVisitor(),
    );

    assert.doesNotMatch(source, /from "zod"/);
    assert.doesNotMatch(source, /wireSchema/);
    assert.doesNotMatch(source, /z\.preprocess/);
  });

  it("emits Zod validators that delegate input canonicalization to load/save", () => {
    const source = emitTypeScriptFile(
      fileDecl(
        typeDecl([
          field("name", { kind: "scalar", scalarType: "string" }, false),
        ]),
      ),
      new TypeScriptExprVisitor(),
      undefined,
      "",
      { nativeSerialization: "zod" },
    );

    assert.match(source, /import \{ z \} from "zod";/);
    assert.match(
      source,
      /static readonly wireObjectSchema: z\.ZodObject<any> = z\.object\(\{/,
    );
    assert.match(source, /"name": z\.string\(\),/);
    assert.match(
      source,
      /static readonly wireSchema: z\.ZodType<Record<string, unknown>> = z\.lazy\(\(\) => CollectionModel\.wireObjectSchema\);/,
    );
    assert.match(
      source,
      /static readonly schema = z\.any\(\)\.transform\(\(data, ctx\) => \{/,
    );
    assert.match(
      source,
      /return CollectionModel\.load\(data as Record<string, unknown>\)\.save\(\);/,
    );
    assert.match(
      source,
      /ctx\.addIssue\(\{ code: z\.ZodIssueCode\.custom, message: String\(error\) \}\);/,
    );
    assert.match(source, /\}\)\.pipe\(CollectionModel\.wireSchema\);/);
    assert.match(
      source,
      /export type CollectionModelWire = z\.infer<typeof CollectionModel\.wireSchema>;/,
    );
  });

  it("guards open discriminator Zod fallback from accepting known discriminator claims", () => {
    const base = typeDecl([
      field("kind", { kind: "scalar", scalarType: "string" }, false),
    ]);
    base.typeName = { namespace: "Test", name: "BaseModel" };
    base.polymorphicDispatch = {
      discriminatorField: "kind",
      variants: [
        { value: "known", typeName: { namespace: "Test", name: "KnownModel" } },
      ],
      defaultVariant: {
        typeName: { namespace: "Test", name: "BaseModel" },
        isSelfReference: true,
      },
      isAbstract: false,
      isClosed: false,
    };
    base.load.hasPolymorphicDispatch = true;

    const knownKind = field(
      "kind",
      { kind: "scalar", scalarType: "string" },
      false,
    );
    knownKind.defaultValue = "known";
    const known = typeDecl([
      knownKind,
      field("required", { kind: "scalar", scalarType: "string" }, false),
    ]);
    known.typeName = { namespace: "Test", name: "KnownModel" };
    known.base = { namespace: "Test", name: "BaseModel" };
    known.save.hasBase = true;
    known.load.assignments = known.load.assignments.map((assignment) => ({
      ...assignment,
      parentTypeName: "KnownModel",
    }));
    known.save.assignments = known.save.assignments.map((assignment) => ({
      ...assignment,
      parentTypeName: "KnownModel",
    }));

    const source = emitTypeScriptFile(
      fileDecls([base, known]),
      new TypeScriptExprVisitor(),
      undefined,
      "",
      { nativeSerialization: "zod" },
    );

    assert.match(
      source,
      /z\.union\(\[KnownModel\.wireObjectSchema as any, BaseModel\.wireObjectSchema\.passthrough\(\)\.refine\(data => !\["known"\]\.includes\(String\(\(data as Record<string, unknown>\)\["kind"\]\)\), \{ message: "Known kind discriminator values must match their concrete schema\." \}\)\]\)/,
    );
  });
});

interface GeneratedNamedCollectionModel {
  parameters: Record<string, unknown>[];
}

interface GeneratedNamedCollectionConstructor {
  load(data: Record<string, unknown>): GeneratedNamedCollectionModel;
}

/**
 * Transpile and execute an emitted named-collection file so both accepted entry forms and the
 * rejected one are asserted against real behaviour. The element type is not emitted here, so
 * `Parameter` is injected as a scope variable with a loader that echoes the payload it receives.
 */
function evaluateNamedCollectionModel(
  source: string,
): GeneratedNamedCollectionConstructor {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      useDefineForClassFields: true,
    },
  }).outputText;
  const exports: Record<string, unknown> = {};
  const loadContext = class {
    readonly path: string = "parameters";
    at(): this {
      return this;
    }
    atIndex(): this {
      return this;
    }
    processInput<T>(value: T): T {
      return value;
    }
    processOutput<T>(value: T): T {
      return value;
    }
  };
  const saveContext = class {};
  const requireModule = (name: string): unknown => {
    if (name === "./context") {
      return { LoadContext: loadContext, SaveContext: saveContext };
    }
    throw new Error(`Unexpected generated import: ${name}`);
  };
  const parameter = { load: (data: Record<string, unknown>) => ({ ...data }) };
  const execute = new Function("exports", "require", "Parameter", output);
  execute(exports, requireModule, parameter);
  assert.equal(typeof exports.CollectionModel, "function");
  return exports.CollectionModel as GeneratedNamedCollectionConstructor;
}

describe("TypeScript named collection entry forms", () => {
  /**
   * `spec/vectors/model/named_collection_vectors.json` states the contract in its header:
   * "Array-valued entries in name-keyed object form are rejected recursively, while arrays in
   * declared entry fields remain valid." Its first vector, `unique_names_use_canonical_object_form`,
   * loads the collection itself as an array of entry objects and expects success.
   *
   * Both halves are asserted together here because they are easy to conflate: the rejection is
   * scoped to an array sitting under a key *inside* name-keyed object form, and must never
   * generalise to the collection-level array form.
   */
  it("accepts the collection-level array form while rejecting arrays under keys in object form", () => {
    const type = typeDecl([
      field(
        "parameters",
        { kind: "collection_complex", typeName: "Parameter" },
        false,
      ),
    ]);
    const source = emitTypeScriptFile(
      fileDecl(type),
      new TypeScriptExprVisitor(),
    );
    const CollectionModel = evaluateNamedCollectionModel(source);

    const listForm = CollectionModel.load({
      parameters: [
        { name: "city", kind: "string", required: true },
        { name: "unit", kind: "string" },
      ],
    });
    assert.deepEqual(listForm.parameters, [
      { name: "city", kind: "string", required: true },
      { name: "unit", kind: "string" },
    ]);

    const objectForm = CollectionModel.load({
      parameters: { city: { kind: "string", required: true } },
    });
    assert.deepEqual(objectForm.parameters, [
      { name: "city", kind: "string", required: true },
    ]);

    const shorthandForm = CollectionModel.load({
      parameters: { city: "string" },
    });
    assert.deepEqual(shorthandForm.parameters, [
      { name: "city", kind: "string" },
    ]);

    assert.throws(
      () =>
        CollectionModel.load({
          parameters: { properties: [{ name: "city", kind: "string" }] },
        }),
      /invalid named collection entry category array/,
    );
  });
});

interface GeneratedConnection {
  kind: string;
  name?: string;
  save(): Record<string, unknown>;
}

interface GeneratedConnectionModule {
  Connection: { load(data: Record<string, unknown>): GeneratedConnection };
  UnknownConnection?: unknown;
}

/**
 * Transpile and execute an emitted abstract-open polymorphic file so a round-trip can be
 * asserted on real behaviour rather than on the shape of the emitted text. `ReferenceConnection`
 * is not emitted here, so it is stubbed with a loader that mirrors what the emitter would
 * produce for a known variant.
 */
function evaluateOpenConnection(source: string): GeneratedConnectionModule {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      useDefineForClassFields: true,
    },
  }).outputText;
  const exports: Record<string, unknown> = {};
  const loadContext = class {
    at(): this {
      return this;
    }
    processInput<T>(value: T): T {
      return value;
    }
    processOutput<T>(value: T): T {
      return value;
    }
  };
  const saveContext = class {};
  const requireModule = (name: string): unknown => {
    if (name === "./context") {
      return { LoadContext: loadContext, SaveContext: saveContext };
    }
    throw new Error(`Unexpected generated import: ${name}`);
  };
  const preamble =
    "class ReferenceConnection extends exports.__base { static load() { return new ReferenceConnection(); } }\n";
  const execute = new Function(
    "exports",
    "require",
    `${output}\nexports.__base = exports.Connection;\n${preamble}exports.ReferenceConnection = ReferenceConnection;`,
  );
  execute(exports, requireModule);
  return exports as unknown as GeneratedConnectionModule;
}

function abstractOpenConnection(): TypeDecl {
  const connection = typeDecl([
    field("kind", { kind: "scalar", scalarType: "string" }, false),
    field("name", { kind: "scalar", scalarType: "string" }, true),
  ]);
  connection.typeName = { namespace: "Test", name: "Connection" };
  connection.isAbstract = true;
  connection.load.hasPolymorphicDispatch = true;
  for (const a of connection.load.assignments) {
    a.parentTypeName = "Connection";
  }
  for (const a of connection.save.assignments) {
    a.parentTypeName = "Connection";
  }
  connection.polymorphicDispatch = {
    discriminatorField: "kind",
    variants: [
      {
        value: "reference",
        typeName: { namespace: "Test", name: "ReferenceConnection" },
      },
    ],
    defaultVariant: null,
    isClosed: false,
    isAbstract: true,
  };
  return connection;
}

describe("TypeScript abstract open polymorphic dispatch", () => {
  it("absorbs unknown discriminators into a carrier instead of throwing", () => {
    const source = emitTypeScriptFile(
      fileDecl(abstractOpenConnection()),
      new TypeScriptExprVisitor(),
    );

    // The base must stay abstract — the schema said @abstract, so `new Connection()` should
    // remain a compile error. The carrier is what makes the open fallback constructible.
    assert.match(source, /export abstract class Connection/);
    assert.match(
      source,
      /export class UnknownConnection extends Connection \{/,
    );
    assert.doesNotMatch(source, /Unknown Connection discriminator field/);
    assert.match(
      source,
      /default:\s+return UnknownConnection\.load\(data, context\);/,
    );
    assert.match(
      source,
      /Invalid Connection discriminator field 'kind': expected non-blank string/,
    );

    const { Connection } = evaluateOpenConnection(source);

    // spec/vectors/model/connection_roundtrip_vectors.json,
    // case "unknown_connection_kind_preserves_payload": the exact kind and the complete
    // payload must survive, including explicit nulls and nested structures.
    const payload = {
      kind: "future-auth",
      name: "future",
      endpoint: "https://example.invalid",
      notes: null,
      providerOptions: ["alpha", { retry: { attempts: 3 }, nullable: null }],
    };
    const loaded = Connection.load(structuredClone(payload));
    assert.equal(loaded.kind, "future-auth");
    assert.deepEqual(loaded.save(), payload);

    // Deep-cloned, not aliased: mutating the round-tripped payload must not reach back
    // into the instance.
    const saved = loaded.save();
    (saved["providerOptions"] as unknown[])[0] = "mutated";
    assert.deepEqual(loaded.save(), payload);
  });

  it("matches unknown discriminators case-sensitively", () => {
    const source = emitTypeScriptFile(
      fileDecl(abstractOpenConnection()),
      new TypeScriptExprVisitor(),
    );
    const { Connection, ReferenceConnection } = evaluateOpenConnection(
      source,
    ) as unknown as {
      Connection: { load(data: Record<string, unknown>): GeneratedConnection };
      ReferenceConnection: Function;
    };

    // spec/vectors/model/connection_roundtrip_vectors.json,
    // case "unknown_connection_case_collision_preserves_payload": "Reference" must NOT
    // coerce to the known "reference" variant.
    const loaded = Connection.load({
      kind: "Reference",
      name: "collision",
      extra: 1,
    });
    assert.equal(loaded.kind, "Reference");
    assert.notEqual(loaded.constructor, ReferenceConnection);
    assert.deepEqual(loaded.save(), {
      kind: "Reference",
      name: "collision",
      extra: 1,
    });
  });

  it("does not emit a carrier for a closed abstract dispatch", () => {
    // Counterpart guard: a closed discriminator has no unknown values to absorb, so
    // rejecting them stays correct and no carrier should appear.
    const connection = abstractOpenConnection();
    connection.polymorphicDispatch!.isClosed = true;
    const source = emitTypeScriptFile(
      fileDecl(connection),
      new TypeScriptExprVisitor(),
    );

    assert.doesNotMatch(source, /class UnknownConnection/);
    assert.doesNotMatch(source, /protected raw: Record<string, unknown>/);
    assert.match(source, /Unknown Connection discriminator field/);
    assert.match(
      source,
      /Invalid Connection discriminator field 'kind': expected non-blank string/,
    );
  });
});

describe("TypeScript open polymorphic preservation", () => {
  it("preserves exact unknown discriminators and payloads without case folding", () => {
    const connection = typeDecl([
      field("kind", { kind: "scalar", scalarType: "string" }, false),
      field("name", { kind: "scalar", scalarType: "string" }, true),
    ]);
    connection.typeName = { namespace: "Test", name: "Connection" };
    connection.load.hasPolymorphicDispatch = true;
    connection.polymorphicDispatch = {
      discriminatorField: "kind",
      variants: [
        {
          value: "reference",
          typeName: { namespace: "Test", name: "ReferenceConnection" },
        },
      ],
      defaultVariant: {
        typeName: { namespace: "Test", name: "Connection" },
        isSelfReference: true,
      },
      isClosed: false,
      isAbstract: false,
    };

    const source = emitTypeScriptFile(
      fileDecl(connection),
      new TypeScriptExprVisitor(),
    );

    assert.match(source, /protected raw: Record<string, unknown> = \{\};/);
    assert.match(
      source,
      /protected static cloneRawValue\(value: unknown\): unknown/,
    );
    // Open union whose only fallback is the self-referencing base (no declared
    // `*` variant): an absent/blank/non-string discriminator names no variant
    // and is rejected up front. Tolerance is reserved for a DECLARED wildcard.
    assert.match(
      source,
      /expected non-blank string/,
    );
    assert.doesNotMatch(
      source,
      /const discriminator =\s*typeof discriminatorValue === "string" \? discriminatorValue : "";/,
    );
    assert.doesNotMatch(source, /discriminatorValue\)\.toLowerCase\(\)/);
    // Unknown NON-blank discriminators still route to the self-referencing base.
    assert.match(source, /if \(instance\.constructor === Connection\) \{/);
    assert.match(
      source,
      /instance\.raw = Connection\.cloneRawValue\(data\) as Record<string, unknown>;/,
    );
    assert.match(
      source,
      /const result = Connection\.cloneRawValue\(obj\.raw\) as Record<string, unknown>;/,
    );
    assert.ok(
      source.indexOf("const result = Connection.cloneRawValue(obj.raw)") <
        source.indexOf('result["kind"] = obj.kind'),
      "modeled fields must overwrite retained raw payload",
    );
  });
});
