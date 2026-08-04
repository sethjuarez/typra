import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { EnumDef, TypeDecl } from "../src/ir/declarations.js";
import { emitJavaEnum, emitJavaFileContent } from "../src/languages/java/emitter.js";
import {
  javaEnumTypeName,
  javaIdentifier,
  javaPropertyName,
} from "../src/languages/java/identifiers.js";
import { JavaExprVisitor } from "../src/languages/java/visitor.js";

const emptyLoad = { coercions: [], assignments: [], hasPolymorphicDispatch: false, hasContextHooks: true };
const emptySave = { assignments: [], hasBase: false, hasContextHooks: true };

function typeDecl(fields: TypeDecl["fields"]): TypeDecl {
  return {
    typeName: { namespace: "Test", name: "KeywordModel" },
    base: null,
    isAbstract: false,
    isProtocol: false,
    description: "",
    fields,
    coercionProperty: null,
    load: emptyLoad,
    save: emptySave,
    factories: [],
    collectionHelpers: [],
    polymorphicDispatch: null,
    methods: [],
    wire: null,
  };
}

describe("Java emitter naming", () => {
  it("sanitizes Java keywords and invalid identifiers", () => {
    assert.equal(javaPropertyName("default"), "defaultValue");
    assert.equal(javaIdentifier("9-lives"), "value_9_lives");
    assert.equal(javaPropertyName("wire-key"), "wire_key");
  });

  it("uses safe member names while preserving wire keys", () => {
    const field: TypeDecl["fields"][number] = {
      name: "default",
      typeName: { namespace: "TypeSpec", name: "string" },
      category: { kind: "scalar", scalarType: "string" },
      isOptional: true,
      defaultValue: null,
      allowedValues: [],
      parseAliases: {},
      enumName: null,
      isOpenEnum: false,
      description: "",
      knownAs: {},
    };
    const decl = typeDecl([field]);
    decl.load.assignments.push({
      sourceName: field.name,
      fieldName: field.name,
      category: field.category,
      isOptional: field.isOptional,
      parentTypeName: decl.typeName.name,
      enumName: null,
      allowedValues: [],
      isOpenEnum: false,
      parseAliases: {},
      defaultValue: null,
    });
    decl.save.assignments.push({
      targetName: field.name,
      fieldName: field.name,
      category: field.category,
      isOptional: field.isOptional,
      parentTypeName: decl.typeName.name,
      enumName: null,
      isOpenEnum: false,
    });

    const source = emitJavaFileContent([decl], "test", new JavaExprVisitor(), new Set());

    assert.match(source, /public String defaultValue = null;/);
    assert.match(source, /map\.containsKey\("default"\)/);
    assert.match(source, /result\.defaultValue = String\.valueOf\(map\.get\("default"\)\)/);
    assert.match(source, /result\.put\("default", serializeScalar\(obj\.defaultValue\)\)/);
  });

  it("emits PascalCase public enums as standalone compilation units", () => {
    const enumDef: EnumDef = {
      name: "approvalModeKind",
      values: ["always", "on-demand"],
      parseAliases: {},
      isOpen: false,
    };

    assert.equal(javaEnumTypeName(enumDef.name), "ApprovalModeKind");
    const source = emitJavaEnum(enumDef, "test");
    assert.match(source, /public enum ApprovalModeKind/);
    assert.match(source, /ON_DEMAND\("on-demand"\)/);
  });

  it("uses the normalized enum type in model load and save code", () => {
    const field: TypeDecl["fields"][number] = {
      name: "mode",
      typeName: { namespace: "Test", name: "string" },
      category: { kind: "scalar", scalarType: "string" },
      isOptional: false,
      defaultValue: "always",
      allowedValues: ["always", "never"],
      parseAliases: {},
      enumName: "approvalModeKind",
      isOpenEnum: false,
      description: "",
      knownAs: {},
    };
    const decl = typeDecl([field]);
    decl.load.assignments.push({
      sourceName: field.name,
      fieldName: field.name,
      category: field.category,
      isOptional: field.isOptional,
      parentTypeName: decl.typeName.name,
      enumName: field.enumName,
      allowedValues: field.allowedValues,
      isOpenEnum: false,
      parseAliases: {},
      defaultValue: field.defaultValue,
    });
    decl.save.assignments.push({
      targetName: field.name,
      fieldName: field.name,
      category: field.category,
      isOptional: field.isOptional,
      parentTypeName: decl.typeName.name,
      enumName: field.enumName,
      isOpenEnum: false,
    });

    const source = emitJavaFileContent([decl], "test", new JavaExprVisitor(), new Set());
    assert.match(source, /public ApprovalModeKind mode = ApprovalModeKind\.ALWAYS;/);
    assert.match(source, /result\.mode = ApprovalModeKind\.fromValue/);
  });
});
