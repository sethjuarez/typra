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
    assert.doesNotMatch(source, /from pydantic import/);
    assert.doesNotMatch(source, /BaseModel/);
  });

  it("emits Pydantic v2 models only when native serialization is enabled", () => {
    const type = typeDecl([
      field("inputModalities", { kind: "collection_scalar", scalarType: "string" }, true),
      field("owners", { kind: "collection_complex", typeName: "Owner" }, true),
      field("outputModalities", { kind: "collection_scalar", scalarType: "string" }, true, true),
      field("defaultOwners", { kind: "collection_complex", typeName: "Owner" }, true, true),
      field("requiredTags", { kind: "collection_scalar", scalarType: "string" }, false),
    ]);
    type.save.assignments = type.save.assignments.map(assignment => ({
      ...assignment,
      targetName: assignment.fieldName === "inputModalities" ? "inputModalitiesWire" : assignment.targetName,
    }));

    const source = emitPythonFile(fileDecl(type), new PythonExprVisitor(), "", {
      nativeSerialization: "pydantic",
    });

    assert.match(source, /^import json$/m);
    assert.match(source, /^from pydantic import BaseModel, ConfigDict, Field$/m);
    assert.doesNotMatch(source, /^from dataclasses import/m);
    assert.match(source, /class ModelInfo\(BaseModel\):/);
    assert.match(source, /model_config = ConfigDict\(populate_by_name=True, arbitrary_types_allowed=True\)/);
    assert.match(source, /input_modalities: list\[str\] \| None = Field\(default=None, alias="inputModalitiesWire"\)/);
    assert.match(source, /owners: list\[Owner\] \| None = Field\(default=None, alias="owners"\)/);
    assert.match(source, /output_modalities: list\[str\] \| None = Field\(default_factory=list, alias="outputModalities"\)/);
    assert.match(source, /default_owners: list\[Owner\] \| None = Field\(default_factory=list, alias="defaultOwners"\)/);
    assert.match(source, /required_tags: list\[str\] = Field\(default_factory=list, alias="requiredTags"\)/);
    assert.match(source, /def model_validate\(cls, obj: Any, \*args: Any, \*\*kwargs: Any\) -> "ModelInfo":/);
    assert.match(source, /return cls\.load\(obj\)/);
    assert.match(source, /def model_validate_json\(cls, json_data: str \| bytes \| bytearray, \*args: Any, \*\*kwargs: Any\) -> "ModelInfo":/);
    assert.match(source, /return cls\.load\(json\.loads\(json_data, strict=False\)\)/);
    assert.match(source, /def model_validate_strings\(cls, obj: Any, \*args: Any, \*\*kwargs: Any\) -> "ModelInfo":/);
    assert.match(source, /does not support model_validate_strings\(\)/);
    assert.match(source, /def model_dump\(self, \*args: Any, \*\*kwargs: Any\) -> dict\[str, Any\]:/);
    assert.match(source, /return self\.save\(\)/);
    assert.match(source, /def model_dump_json\(self, \*args: Any, \*\*kwargs: Any\) -> str:/);
    assert.match(source, /return self\.to_json\(indent=indent\)/);
  });

  it("fails loudly when a field would collide with Pydantic interop names", () => {
    const type = typeDecl([
      field("modelValidateJson", { kind: "scalar", scalarType: "string" }, false),
    ]);

    assert.throws(
      () => emitPythonFile(fileDecl(type), new PythonExprVisitor(), "", {
        nativeSerialization: "pydantic",
      }),
      /ModelInfo\.modelValidateJson.*model_validate_json.*reserved by Pydantic\/Typra interop/,
    );
  });

  it("fails loudly when a factory would collide with Pydantic interop names", () => {
    const type = typeDecl([]);
    type.factories = [{
      name: "model_validate_json",
      params: {},
      body: {
        kind: "construct",
        typeName: { namespace: "Test", name: "ModelInfo" },
        fields: [],
      },
    }];

    assert.throws(
      () => emitPythonFile(fileDecl(type), new PythonExprVisitor(), "", {
        nativeSerialization: "pydantic",
      }),
      /ModelInfo\.model_validate_json factory.*model_validate_json.*reserved by Pydantic\/Typra interop/,
    );
  });
});

function abstractOpenConnection(): TypeDecl {
  const connection = typeDecl([
    field("kind", { kind: "scalar", scalarType: "string" }, false),
    field("label", { kind: "scalar", scalarType: "string" }, true),
  ]);
  connection.typeName = { namespace: "Test", name: "Connection" };
  connection.isAbstract = true;
  connection.load.hasPolymorphicDispatch = true;
  connection.polymorphicDispatch = {
    discriminatorField: "kind",
    variants: [{ value: "managed", typeName: { namespace: "Test", name: "ManagedConnection" } }],
    defaultVariant: null,
    isClosed: false,
    isAbstract: true,
  };
  return connection;
}

describe("Python abstract open polymorphic dispatch", () => {
  it("absorbs unknown discriminators into a carrier instead of raising", () => {
    const type = abstractOpenConnection();
    const decl = fileDecl(type);
    decl.containsAbstract = true;
    const source = emitPythonFile(decl, new PythonExprVisitor());

    // The base keeps its ABC marker: the schema said @abstract and that stays true.
    assert.match(source, /class Connection\(ABC\):/);
    assert.match(source, /class UnknownConnection\(Connection\):/);
    assert.doesNotMatch(source, /Unknown Connection discriminator field/);
    assert.doesNotMatch(source, /Missing Connection discriminator property/);
    assert.match(source, /return UnknownConnection\.load\(data, context\)/);

    // The retained payload must be deep-copied and stripped of the declared fields, so a
    // save re-emits the unknown keys without duplicating the modelled ones.
    assert.match(source, /instance\._raw = copy\.deepcopy\(data\)/);
    assert.match(source, /instance\._raw\.pop\("kind", None\)/);
    assert.match(source, /instance\._raw\.pop\("label", None\)/);
    assert.match(source, /result: dict\[str, Any\] = copy\.deepcopy\(obj\._raw\)/);
    assert.match(source, /^import copy$/m);
  });

  it("uses Pydantic private attributes for open discriminator raw payloads", () => {
    const type = abstractOpenConnection();
    const decl = fileDecl(type);
    decl.containsAbstract = true;
    const source = emitPythonFile(decl, new PythonExprVisitor(), "", {
      nativeSerialization: "pydantic",
    });

    assert.match(source, /^from pydantic import BaseModel, ConfigDict, Field, PrivateAttr$/m);
    assert.match(source, /class Connection\(BaseModel, ABC\):/);
    assert.match(source, /_raw: dict\[str, Any\] = PrivateAttr\(default_factory=dict\)/);
    assert.match(source, /class UnknownConnection\(Connection\):/);
    assert.doesNotMatch(source, /@dataclass/);
    assert.match(source, /instance\._raw = copy\.deepcopy\(data\)/);
    assert.match(source, /result: dict\[str, Any\] = copy\.deepcopy\(obj\._raw\)/);
  });

  it("does not emit a carrier for a closed abstract dispatch", () => {
    // Counterpart guard: a closed discriminator has no unknown values to absorb.
    const type = abstractOpenConnection();
    type.polymorphicDispatch!.isClosed = true;
    const decl = fileDecl(type);
    decl.containsAbstract = true;
    const source = emitPythonFile(decl, new PythonExprVisitor());

    assert.doesNotMatch(source, /class UnknownConnection/);
    assert.doesNotMatch(source, /_raw: dict\[str, Any\]/);
    assert.match(source, /Unknown Connection discriminator field/);
    assert.match(source, /Missing Connection discriminator property/);
  });
});
