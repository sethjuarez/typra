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
import { emitJavaSaveContext } from "../src/languages/java/scaffolding.js";
import { emitJavaTest } from "../src/languages/java/test-emitter.js";
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

  it("normalizes only explicitly keyed collections and honors save preferences", () => {
    const items = field("items", "FixtureBagItem", {
      typeName: { namespace: "Test", name: "FixtureBagItem[]" },
      category: { kind: "collection_complex", typeName: "FixtureBagItem" },
    });
    const decl = typeDecl([items]);
    decl.typeName = { namespace: "Test", name: "FixtureBag" };
    decl.collectionHelpers = [{
      propertyName: "items",
      elementTypeName: { namespace: "Test", name: "FixtureBagItem" },
      innerFields: ["note"],
      hasNameProperty: true,
    }];
    addAssignments(decl);

    const source = emitJavaFileContent([decl], "test", new JavaExprVisitor(), new Set());

    assert.match(source, /if \(data instanceof Map<\?, \?> values\)/);
    assert.match(source, /itemData\.put\("name", String\.valueOf\(entry\.getKey\(\)\)\)/);
    assert.match(source, /"array"\.equals\(ctx\.collectionFormat\)/);
    assert.match(source, /ctx\.useShorthand/);
  });

  it("keeps ordinary complex collections as arrays even when elements are nameable", () => {
    const anyOf = field("anyOf", "FixtureProperty", {
      typeName: { namespace: "Test", name: "FixtureProperty[]" },
      category: { kind: "collection_complex", typeName: "FixtureProperty" },
    });
    const decl = typeDecl([anyOf]);
    decl.typeName = { namespace: "Test", name: "FixtureUnionProperty" };
    decl.collectionHelpers = [{
      propertyName: "anyOf",
      elementTypeName: { namespace: "Test", name: "FixtureProperty" },
      innerFields: ["kind", "name"],
      hasNameProperty: false,
    }];
    addAssignments(decl);

    const source = emitJavaFileContent([decl], "test", new JavaExprVisitor(), new Set());

    assert.doesNotMatch(source, /data instanceof Map<\?, \?> values/);
    assert.doesNotMatch(source, /collectionFormat/);
    assert.match(source, /for \(FixtureProperty item : items\) result\.add\(item\.save\(ctx\)\)/);
  });

  it("finalizes derived saves once after accumulating inherited fields", () => {
    const base = typeDecl([field("id", "string")]);
    base.typeName = { namespace: "Test", name: "BaseModel" };
    addAssignments(base);
    const derived = typeDecl([field("id", "string"), field("label", "string")]);
    derived.typeName = { namespace: "Test", name: "DerivedModel" };
    derived.base = base.typeName;
    derived.save.hasBase = true;
    addAssignments(derived);

    const source = emitJavaFileContent([derived], "test", new JavaExprVisitor(), new Set(), [], [base, derived]);

    assert.match(source, /BaseModel\.saveFieldsInto\(obj, result, ctx\)/);
    assert.doesNotMatch(source, /super\.save\(ctx\)/);
    assert.equal((source.match(/return ctx\.processDict\(result\)/g) ?? []).length, 1);
  });

  it("preserves optional defaults as absence and initializes required enums", () => {
    const optionalDefault = field("mode", "string", {
      isOptional: true,
      defaultValue: "auto",
    });
    const requiredEnum = field("status", "string", {
      enumName: "fixtureStatus",
      allowedValues: ["draft", "ready"],
    });
    const decl = typeDecl([optionalDefault, requiredEnum]);
    addAssignments(decl);

    const source = emitJavaFileContent([decl], "test", new JavaExprVisitor(), new Set());

    assert.match(source, /public String mode = null;/);
    assert.match(source, /if \(obj\.mode != null\) result\.put\("mode"/);
    assert.match(source, /public FixtureStatus status = FixtureStatus\.DRAFT;/);
    assert.match(source, /result\.put\("status", obj\.status\.value\);/);
  });

  it("emits disjoint integer and numeric coercion branches", () => {
    const decl = typeDecl([field("count", "int32"), field("ratio", "float64")]);
    decl.load.coercions = [
      {
        scalarType: "number",
        assignments: [{ fieldName: "ratio", isInput: true }],
        needsDispatch: false,
      },
      {
        scalarType: "int32",
        assignments: [{ fieldName: "count", isInput: true }],
        needsDispatch: false,
      },
    ];

    const source = emitJavaFileContent([decl], "test", new JavaExprVisitor(), new Set());
    const integerBranch = source.indexOf("data instanceof Byte");
    const numberBranch = source.indexOf("data instanceof Number");

    assert.ok(integerBranch >= 0);
    assert.ok(numberBranch > integerBranch);
  });

  it("exposes Java collection and shorthand save settings compatibly", () => {
    const source = emitJavaSaveContext("test");

    assert.match(source, /public final String collectionFormat;/);
    assert.match(source, /public final boolean useShorthand;/);
    assert.match(source, /this\(preSave, postSave, "object", true\)/);
    assert.match(source, /public SaveContext\(String collectionFormat, boolean useShorthand\)/);
  });
});

describe("Java generated tests", () => {
  it("validates object-form named collections through their generated List model", () => {
    const item = new TypeNode({} as Model, "");
    item.typeName = { namespace: "Test", name: "FixtureBagItem" };
    const name = new PropertyNode({} as ModelProperty, "");
    name.name = "name";
    name.isScalar = true;
    name.typeName = { namespace: "TypeSpec", name: "string" };
    const note = new PropertyNode({} as ModelProperty, "");
    note.name = "note";
    note.isScalar = true;
    note.typeName = { namespace: "TypeSpec", name: "string" };
    item.properties = [name, note];

    const bag = new TypeNode({} as Model, "");
    bag.typeName = { namespace: "Test", name: "FixtureBag" };
    const items = new PropertyNode({} as ModelProperty, "");
    items.name = "items";
    items.typeName = { namespace: "Test", name: "FixtureBagItem" };
    items.isCollection = true;
    items.type = item;
    bag.properties = [items];

    const source = emitJavaTest({
      node: bag,
      isAbstract: false,
      package: "test",
      examples: [{
        sample: { items: { alpha: { note: "first" } } },
        json: ['{"items":{"alpha":{"note":"first"}}}'],
        yaml: [],
        validations: [],
      }],
      coercions: [],
      factories: [],
    });

    assert.match(source, /instance1\.items\.size\(\)/);
    assert.match(source, /instance1\.items\.get\(0\)\.name/);
    assert.doesNotMatch(source, /instance1\.items\.get\("alpha"\)/);
  });

  it("uses canonical Java string literals and typed nested comparisons", () => {
    const config = new TypeNode({} as Model, "");
    config.typeName = { namespace: "Test", name: "McpApprovalConfig" };
    const kind = new PropertyNode({} as ModelProperty, "");
    kind.name = "kind";
    kind.isScalar = true;
    kind.typeName = { namespace: "TypeSpec", name: "string" };
    config.properties = [kind];
    config.coercions = [{
      scalar: "string",
      expansion: { kind: "{value}" },
      title: "config",
      description: "",
      example: "always",
    }];

    const approval = new TypeNode({} as Model, "");
    approval.typeName = { namespace: "Test", name: "McpApprovalMode" };
    const configProp = new PropertyNode({} as ModelProperty, "");
    configProp.name = "config";
    configProp.typeName = config.typeName;
    configProp.type = config;
    approval.properties = [configProp];

    const source = emitJavaTest({
      node: approval,
      isAbstract: false,
      package: "test",
      examples: [{
        sample: { config: "always" },
        json: ['{"config":"line\\n\\"always\\""}'],
        yaml: [],
        validations: [{ key: "config", value: "always", delimiter: '"', isOptional: false }],
      }],
      coercions: [],
      factories: [],
    });

    assert.doesNotMatch(source, /String jsonData1 = """/);
    assert.match(source, /instance1\.config\.kind/);
    assert.doesNotMatch(source, /assertEquals\("always", instance1\.config,/);
  });
});
