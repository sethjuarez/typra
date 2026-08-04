import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Model, ModelProperty } from "@typespec/compiler";

import type { EnumDef, TypeDecl } from "../src/ir/declarations.js";
import { PropertyNode, TypeNode } from "../src/ir/ast.js";
import { TypeRegistry } from "../src/ir/expansion.js";
import { emitJavaEnum, emitJavaFileContent, emitJavaMethodHelper } from "../src/languages/java/emitter.js";
import {
  javaEnumTypeName,
  javaIdentifier,
  javaPropertyName,
} from "../src/languages/java/identifiers.js";
import { JavaExprVisitor } from "../src/languages/java/visitor.js";

function typeDecl(fields: TypeDecl["fields"]): TypeDecl {
  return {
    typeName: { namespace: "Test", name: "KeywordModel" },
    base: null,
    isAbstract: false,
    isProtocol: false,
    description: "",
    fields,
    coercionProperty: null,
    load: { coercions: [], assignments: [], hasPolymorphicDispatch: false, hasContextHooks: true },
    save: { assignments: [], hasBase: false, hasContextHooks: true },
    factories: [],
    collectionHelpers: [],
    polymorphicDispatch: null,
    methods: [],
    wire: null,
  };
}

function field(
  name: string,
  scalarType: string,
  options: Partial<TypeDecl["fields"][number]> = {},
): TypeDecl["fields"][number] {
  return {
    name,
    typeName: { namespace: "TypeSpec", name: scalarType },
    category: { kind: "scalar", scalarType },
    isOptional: false,
    defaultValue: null,
    allowedValues: [],
    parseAliases: {},
    enumName: null,
    isOpenEnum: false,
    description: "",
    knownAs: {},
    ...options,
  };
}

function addAssignments(decl: TypeDecl): void {
  for (const item of decl.fields) {
    decl.load.assignments.push({
      sourceName: item.name,
      fieldName: item.name,
      category: item.category,
      isOptional: item.isOptional,
      parentTypeName: decl.typeName.name,
      enumName: item.enumName,
      allowedValues: item.allowedValues,
      isOpenEnum: item.isOpenEnum,
      parseAliases: item.parseAliases,
      defaultValue: item.defaultValue,
    });
    decl.save.assignments.push({
      targetName: item.name,
      fieldName: item.name,
      category: item.category,
      isOptional: item.isOptional,
      parentTypeName: decl.typeName.name,
      enumName: item.enumName,
      isOpenEnum: item.isOpenEnum,
    });
  }
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
    assert.match(source, /public ApprovalModeKind mode = ApprovalModeKind\.fromValue\("always"\);/);
    assert.match(source, /result\.mode = ApprovalModeKind\.fromValue/);
  });
});

describe("Java emitter runtime semantics", () => {
  it("dispatches abstract wildcard variants without instantiating the abstract base", () => {
    const base = typeDecl([field("kind", "string"), field("name", "string")]);
    base.typeName = { namespace: "Test", name: "Tool" };
    base.isAbstract = true;
    base.polymorphicDispatch = {
      discriminatorField: "kind",
      variants: [{ value: "known", typeName: { namespace: "Test", name: "KnownTool" } }],
      defaultVariant: {
        typeName: { namespace: "Test", name: "CustomTool" },
        isSelfReference: false,
      },
      isAbstract: true,
    };
    addAssignments(base);

    const custom = typeDecl([
      field("kind", "string", { defaultValue: "*" }),
      field("options", "dictionary", {
        typeName: { namespace: "TypeSpec", name: "Record<unknown>" },
        category: { kind: "dict" },
      }),
    ]);
    custom.typeName = { namespace: "Test", name: "CustomTool" };
    custom.base = base.typeName;
    custom.save.hasBase = true;
    addAssignments(custom);

    const baseSource = emitJavaFileContent([base], "test", new JavaExprVisitor(), new Set(), [], [base, custom]);
    const customSource = emitJavaFileContent([custom], "test", new JavaExprVisitor(), new Set(), [], [base, custom]);

    assert.doesNotMatch(baseSource, /new Tool\(\)/);
    assert.match(baseSource, /default:\s+return CustomTool\.load\(data, ctx\);/);
    assert.match(baseSource, /Cannot instantiate abstract Tool/);
    assert.doesNotMatch(customSource, /public String kind/);
    assert.match(customSource, /this\.kind = "\*";/);
    assert.match(customSource, /Tool\.loadBaseInto\(result, map, ctx\);/);
    assert.doesNotMatch(customSource, /map\.containsKey\("kind"\)/);
    assert.doesNotMatch(customSource, /result\.put\("kind"/);
  });

  describe("Java method extension seams", () => {
    it("delegates generated model methods to a hand-editable helper", () => {
      const decl = typeDecl([]);
      decl.typeName = { namespace: "Test", name: "Message" };
      decl.methods = [{
        name: "text",
        returns: "string",
        description: "Render message text.",
        params: { prefix: "string" },
        optional: false,
        sync: true,
      }];

      const modelSource = emitJavaFileContent([decl], "test", new JavaExprVisitor(), new Set());
      const helper = emitJavaMethodHelper(decl, "test");

      assert.match(modelSource, /return MessageMethods\.text\(this, prefix\);/);
      assert.ok(helper);
      assert.equal(helper.filename, "MessageMethods.java");
      assert.match(helper.source, /public static String text\(Message self, String prefix\)/);
      assert.match(helper.source, /Implement Message\.text in MessageMethods/);
      assert.doesNotMatch(helper.source, /Code generated|auto-generated/);
    });

    it("delegates void methods without returning a value", () => {
      const decl = typeDecl([]);
      decl.typeName = { namespace: "Test", name: "Message" };
      decl.methods = [{
        name: "clear",
        returns: "void",
        description: "Clear the message.",
        params: {},
        optional: false,
        sync: true,
      }];

      const modelSource = emitJavaFileContent([decl], "test", new JavaExprVisitor(), new Set());
      assert.match(modelSource, /MessageMethods\.clear\(this\);/);
      assert.doesNotMatch(modelSource, /return MessageMethods\.clear/);
    });

    it("does not create method helpers for protocol interfaces", () => {
      const decl = typeDecl([]);
      decl.typeName = { namespace: "Test", name: "MessageSink" };
      decl.isProtocol = true;
      decl.methods = [{
        name: "emit",
        returns: "void",
        description: "Emit a message.",
        params: { value: "string" },
        optional: false,
        sync: true,
      }];

      assert.equal(emitJavaMethodHelper(decl, "test"), null);
    });
  });

  it("uses enum factories and boxed numeric literals in generated expressions", () => {
    const model = new TypeNode({} as Model, "");
    model.typeName = { namespace: "Test", name: "FactoryModel" };
    const mode = new PropertyNode({} as ModelProperty, "");
    mode.name = "mode";
    mode.typeName = { namespace: "Test", name: "string" };
    mode.enumName = "factoryMode";
    mode.allowedValues = ["fast", "slow"];
    const count = new PropertyNode({} as ModelProperty, "");
    count.name = "count";
    count.typeName = { namespace: "TypeSpec", name: "int64" };
    const ratio = new PropertyNode({} as ModelProperty, "");
    ratio.name = "ratio";
    ratio.typeName = { namespace: "TypeSpec", name: "float64" };
    model.properties = [mode, count, ratio];
    const registry = TypeRegistry.fromTypeGraph([model]);
    const visitor = new JavaExprVisitor(registry);

    const source = visitor.visitExpr({
      kind: "construct",
      typeName: model.typeName,
      fields: [
        { propertyName: "mode", value: { kind: "string", value: "fast" }, isOptional: false },
        { propertyName: "count", value: { kind: "number", value: 1 }, isOptional: false },
        { propertyName: "ratio", value: { kind: "number", value: 1 }, isOptional: false },
      ],
    });

    assert.match(source, /this\.mode = FactoryMode\.fromValue\("fast"\)/);
    assert.match(source, /this\.count = 1L/);
    assert.match(source, /this\.ratio = 1\.0d/);
  });

  it("converts enum shorthand values and emits typed numeric defaults", () => {
    const mode = field("mode", "string", {
      enumName: "factoryMode",
      allowedValues: ["fast", "slow"],
    });
    const count = field("count", "int64", { defaultValue: 1 });
    const ratio = field("ratio", "float64", { defaultValue: 1 });
    const decl = typeDecl([mode, count, ratio]);
    decl.load.coercions.push({
      scalarType: "string",
      assignments: [{ fieldName: "mode", isInput: true }],
      needsDispatch: false,
    });
    addAssignments(decl);

    const source = emitJavaFileContent([decl], "test", new JavaExprVisitor(), new Set());
    assert.match(source, /result\.mode = FactoryMode\.fromValue\(String\.valueOf\(data\)\)/);
    assert.match(source, /public Long count = 1L;/);
    assert.match(source, /public Double ratio = 1\.0d;/);
  });
});
