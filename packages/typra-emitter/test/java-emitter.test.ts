import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Model, ModelProperty } from "@typespec/compiler";

import type { EnumDef, TypeDecl } from "../src/ir/declarations.js";
import { PropertyNode, TypeNode } from "../src/ir/ast.js";
import { TypeRegistry } from "../src/ir/expansion.js";
import { javaTestOptions } from "../src/languages/java/driver.js";
import { emitJavaEnum, emitJavaFileContent, emitJavaMethodHelper } from "../src/languages/java/emitter.js";
import { emitJavaSaveContext } from "../src/languages/java/scaffolding.js";
import { emitJavaTest } from "../src/languages/java/test-emitter.js";
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

  describe("Java generated tests", () => {
    it("preserves raw multiline strings for Java literal rendering", () => {
      assert.equal(javaTestOptions.escapeString("some \npersonal"), "some \npersonal");
    });

    it("asserts named map/list shorthand and expanded collection items", () => {
      const item = new TypeNode({ name: "Binding" } as Model, "");
      item.typeName = { namespace: "Test", name: "Binding" };
      item.coercions = [
        { scalar: "string", expansion: { value: "{value}" } },
        { scalar: "float64", expansion: { weight: "{value}" } },
      ];
      const name = new PropertyNode({ name: "name" } as ModelProperty, "");
      name.typeName = { namespace: "TypeSpec", name: "string" };
      name.isScalar = true;
      const value = new PropertyNode({ name: "value" } as ModelProperty, "");
      value.typeName = { namespace: "TypeSpec", name: "string" };
      value.isScalar = true;
      const weight = new PropertyNode({ name: "weight" } as ModelProperty, "");
      weight.typeName = { namespace: "TypeSpec", name: "number" };
      weight.isScalar = true;
      item.properties = [name, value, weight];

      const container = new TypeNode({ name: "Tool" } as Model, "");
      container.typeName = { namespace: "Test", name: "Tool" };
      const bindings = new PropertyNode({ name: "bindings" } as ModelProperty, "");
      bindings.typeName = item.typeName;
      bindings.type = item;
      bindings.isCollection = true;
      bindings.isNamedCollection = true;
      container.properties = [bindings];

      const source = emitJavaTest({
        node: container,
        isAbstract: false,
        package: "test",
        examples: [{
          sample: {
            bindings: {
              alpha: "text",
              beta: 2.5,
              gamma: { value: "expanded", weight: 3 },
            },
          },
          json: ["{}"],
          yaml: ["{}"],
          validations: [],
        }],
        coercions: [],
        factories: [],
      });

      assert.match(source, /assertEquals\(3, instance1\.bindings\.size\(\), "Expected bindings size"\);/);
      assert.match(source, /assertEquals\("alpha", instance1\.bindings\.get\(0\)\.name, "Expected bindings\.alpha name"\);/);
      assert.match(source, /assertEquals\("text", instance1\.bindings\.get\(0\)\.value, "Expected bindings\.alpha\.value"\);/);
      assert.match(source, /assertEquals\(2\.5, instance1\.bindings\.get\(1\)\.weight, "Expected bindings\.beta\.weight"\);/);
      assert.match(source, /assertEquals\("expanded", instance1\.bindings\.get\(2\)\.value, "Expected instance1\.bindings\.get\(2\)\.value"\);/);
      assert.match(source, /assertEquals\(3, instance1\.bindings\.get\(2\)\.weight, "Expected instance1\.bindings\.get\(2\)\.weight"\);/);
    });

    it("uses legal local identifiers for nested union downcasts", () => {
      const base = new TypeNode({ name: "Property" } as Model, "");
      base.typeName = { namespace: "Test", name: "Property" };
      base.discriminator = "kind";
      const child = new TypeNode({ name: "StringProperty" } as Model, "");
      child.typeName = { namespace: "Test", name: "StringProperty" };
      const kind = new PropertyNode({ name: "kind" } as ModelProperty, "");
      kind.typeName = { namespace: "TypeSpec", name: "string" };
      kind.isScalar = true;
      kind.defaultValue = "string";
      child.properties = [kind];
      base.childTypes = [child];
      base.properties = [kind];

      const container = new TypeNode({ name: "Container" } as Model, "");
      container.typeName = { namespace: "Test", name: "Container" };
      const nested = new PropertyNode({ name: "nested" } as ModelProperty, "");
      nested.typeName = base.typeName;
      nested.type = base;
      nested.isScalar = false;
      container.properties = [nested];

      const source = emitJavaTest({
        node: container,
        isAbstract: false,
        package: "test",
        examples: [{
          sample: { nested: { kind: "string" } },
          json: ["{}"],
          yaml: ["{}"],
          validations: [],
        }],
        coercions: [],
        factories: [],
      });

      assert.match(source, /StringProperty instance1NestedValue = \(StringProperty\) instance1\.nested;/);
      assert.doesNotMatch(source, /StringProperty instance1\.nested/);
    });

    it("uses typed enum values for nested assertions", () => {
      const approval = new TypeNode({ name: "Approval" } as Model, "");
      approval.typeName = { namespace: "Test", name: "Approval" };
      const kind = new PropertyNode({ name: "kind" } as ModelProperty, "");
      kind.name = "kind";
      kind.typeName = { namespace: "TypeSpec", name: "string" };
      kind.isScalar = true;
      kind.enumName = "approvalKind";
      kind.allowedValues = ["always", "never"];
      approval.properties = [kind];

      const container = new TypeNode({ name: "Tool" } as Model, "");
      container.typeName = { namespace: "Test", name: "Tool" };
      const approvalProp = new PropertyNode({ name: "approval" } as ModelProperty, "");
      approvalProp.name = "approval";
      approvalProp.typeName = approval.typeName;
      approvalProp.type = approval;
      container.properties = [approvalProp];

      const source = emitJavaTest({
        node: container,
        isAbstract: false,
        package: "test",
        examples: [{
          sample: { approval: { kind: "always" } },
          json: ["{}"],
          yaml: ["{}"],
          validations: [],
        }],
        coercions: [],
        factories: [],
      });

      assert.match(
        source,
        /assertEquals\(ApprovalKind\.fromValue\("always"\), instance1\.approval\.kind, "Expected instance1\.approval\.kind"\);/,
      );
    });

    it("asserts nested scalar shorthand through its expanded property", () => {
      const format = new TypeNode({ name: "FormatConfig" } as Model, "");
      format.typeName = { namespace: "Test", name: "FormatConfig" };
      format.coercions = [{ scalar: "string", expansion: { kind: "{value}" } }];
      const kind = new PropertyNode({ name: "kind" } as ModelProperty, "");
      kind.typeName = { namespace: "TypeSpec", name: "string" };
      kind.isScalar = true;
      format.properties = [kind];

      const template = new TypeNode({ name: "Template" } as Model, "");
      template.typeName = { namespace: "Test", name: "Template" };
      const formatProp = new PropertyNode({ name: "format" } as ModelProperty, "");
      formatProp.typeName = format.typeName;
      formatProp.type = format;
      template.properties = [formatProp];

      const container = new TypeNode({ name: "Prompt" } as Model, "");
      container.typeName = { namespace: "Test", name: "Prompt" };
      const templateProp = new PropertyNode({ name: "template" } as ModelProperty, "");
      templateProp.typeName = template.typeName;
      templateProp.type = template;
      container.properties = [templateProp];

      const source = emitJavaTest({
        node: container,
        isAbstract: false,
        package: "test",
        examples: [{
          sample: { template: { format: "mustache" } },
          json: ["{}"],
          yaml: ["{}"],
          validations: [],
        }],
        coercions: [],
        factories: [],
      });

      assert.match(
        source,
        /assertEquals\("mustache", instance1\.template\.format\.kind, "Expected format\.kind"\);/,
      );
      assert.doesNotMatch(source, /assertEquals\("mustache", instance1\.template\.format,/);
    });

    it("keeps polymorphic discriminator assertions as raw strings", () => {
      const base = new TypeNode({ name: "Property" } as Model, "");
      base.typeName = { namespace: "Test", name: "Property" };
      base.discriminator = "kind";
      const baseKind = new PropertyNode({ name: "kind" } as ModelProperty, "");
      baseKind.typeName = { namespace: "TypeSpec", name: "string" };
      baseKind.isScalar = true;
      baseKind.enumName = "simpleTypes";
      baseKind.allowedValues = ["string", "number"];
      base.properties = [baseKind];

      const stringProperty = new TypeNode({ name: "StringProperty" } as Model, "");
      stringProperty.typeName = { namespace: "Test", name: "StringProperty" };
      const childKind = new PropertyNode({ name: "kind" } as ModelProperty, "");
      childKind.typeName = { namespace: "TypeSpec", name: "string" };
      childKind.isScalar = true;
      childKind.enumName = "simpleTypes";
      childKind.allowedValues = ["string", "number"];
      childKind.defaultValue = "string";
      const priority = new PropertyNode({ name: "priority" } as ModelProperty, "");
      priority.typeName = { namespace: "TypeSpec", name: "string" };
      priority.isScalar = true;
      priority.enumName = "priority";
      priority.allowedValues = ["normal", "high"];
      priority.defaultValue = "normal";
      stringProperty.properties = [childKind, priority];
      base.childTypes = [stringProperty];

      const container = new TypeNode({ name: "ObjectProperty" } as Model, "");
      container.typeName = { namespace: "Test", name: "ObjectProperty" };
      const properties = new PropertyNode({ name: "properties" } as ModelProperty, "");
      properties.typeName = base.typeName;
      properties.type = base;
      properties.isCollection = true;
      container.properties = [properties];

      const source = emitJavaTest({
        node: container,
        isAbstract: false,
        package: "test",
        examples: [{
          sample: { properties: [{ kind: "string", priority: "normal" }] },
          json: ["{}"],
          yaml: ["{}"],
          validations: [],
        }],
        coercions: [],
        factories: [],
      });

      assert.match(source, /assertEquals\("string", instance1Properties0Value\.kind, "Expected kind"\);/);
      assert.doesNotMatch(source, /SimpleTypes\.fromValue\("string"\)/);
      assert.match(source, /assertEquals\(Priority\.fromValue\("normal"\), instance1Properties0Value\.priority, "Expected priority"\);/);
    });
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
      assert.match(helper.source, /^\/\/ <typra-extension-seam>\n/);
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

  it("routes integral shorthand before the broad numeric branch", () => {
    const kind = field("kind", "string");
    const example = field("example", "unknown");
    const decl = typeDecl([kind, example]);
    decl.load.coercions = [
      {
        scalarType: "float64",
        assignments: [
          { fieldName: "kind", isInput: false, literalValue: "float" },
          { fieldName: "example", isInput: true },
        ],
        needsDispatch: false,
      },
      {
        scalarType: "integer",
        assignments: [
          { fieldName: "kind", isInput: false, literalValue: "integer" },
          { fieldName: "example", isInput: true },
        ],
        needsDispatch: false,
      },
      {
        scalarType: "boolean",
        assignments: [
          { fieldName: "kind", isInput: false, literalValue: "boolean" },
          { fieldName: "example", isInput: true },
        ],
        needsDispatch: false,
      },
      {
        scalarType: "string",
        assignments: [
          { fieldName: "kind", isInput: false, literalValue: "string" },
          { fieldName: "example", isInput: true },
        ],
        needsDispatch: false,
      },
    ];

    const source = emitJavaFileContent([decl], "test", new JavaExprVisitor(), new Set());
    const integralGuard =
      "if (data instanceof Integer || data instanceof Long || data instanceof Short || data instanceof Byte)";
    const numberGuard = "if (data instanceof Number)";
    assert.ok(source.indexOf(integralGuard) < source.indexOf(numberGuard));
    assert.equal(source.match(/if \(data instanceof Number\)/g)?.length, 1);
    assert.match(source, /result\.kind = "integer";\s+result\.example = \(data instanceof Number n \? n\.intValue\(\)/);
    assert.match(source, /result\.kind = "float";\s+result\.example = \(data instanceof Number n \? n\.doubleValue\(\)/);
    assert.match(source, /if \(data instanceof Boolean\)/);
    assert.match(source, /if \(data instanceof String\)/);
  });

  it("preserves optional defaults and initializes required enums", () => {
    const optionalItems = field("items", "string", {
      category: { kind: "collection_scalar", scalarType: "string" },
      isOptional: true,
    });
    const requiredMode = field("mode", "string", {
      enumName: "approvalMode",
      allowedValues: ["always", "never"],
    });
    const requiredModes = field("modes", "string", {
      category: { kind: "collection_scalar", scalarType: "string" },
      enumName: "approvalMode",
      allowedValues: ["always", "never"],
    });
    const decl = typeDecl([optionalItems, requiredMode, requiredModes]);
    addAssignments(decl);

    const source = emitJavaFileContent([decl], "test", new JavaExprVisitor(), new Set());
    assert.match(source, /public List<String> items = null;/);
    assert.match(source, /public ApprovalMode mode = ApprovalMode\.fromValue\("always"\);/);
    assert.match(source, /public List<ApprovalMode> modes = new ArrayList<>\(\);/);
  });

  it("loads and saves explicit named collection maps, lists, and shorthand", () => {
    const bindings = field("bindings", "Binding", {
      typeName: { namespace: "Test", name: "Binding" },
      category: { kind: "collection_complex", typeName: "Binding" },
    });
    const decl = typeDecl([bindings]);
    decl.collectionHelpers = [{
      propertyName: "bindings",
      elementTypeName: bindings.typeName,
      innerFields: ["source"],
      hasNameProperty: true,
    }];
    addAssignments(decl);

    const source = emitJavaFileContent([decl], "test", new JavaExprVisitor(), new Set());
    assert.match(source, /map\.get\("bindings"\) instanceof Map<\?, \?> values/);
    assert.match(source, /Binding item = Binding\.load\(entry\.getValue\(\), ctx\);\s+item\.name = String\.valueOf\(entry\.getKey\(\)\);/);
    assert.match(source, /else if \(map\.get\("bindings"\) instanceof Iterable<\?> values\)/);
    assert.match(source, /if \("array"\.equals\(ctx\.collectionFormat\)\)/);
    assert.match(source, /ctx\.useShorthand && Binding\.SHORTHAND_PROPERTY != null/);
  });

  it("applies postSave once after the complete inheritance chain", () => {
    const base = typeDecl([field("baseValue", "string")]);
    base.typeName = { namespace: "Test", name: "BaseModel" };
    addAssignments(base);
    const child = typeDecl([...base.fields, field("childValue", "string")]);
    child.typeName = { namespace: "Test", name: "ChildModel" };
    child.base = base.typeName;
    child.save.hasBase = true;
    addAssignments(child);

    const source = emitJavaFileContent([child], "test", new JavaExprVisitor(), new Set(), [], [base, child]);
    assert.match(source, /obj\.saveFields\(result, ctx\);\s+return ctx\.processDict\(result\);/);
    assert.match(source, /protected void saveFields\(Map<String, Object> result, SaveContext ctx\) \{\s+super\.saveFields\(result, ctx\);/);
    assert.doesNotMatch(source, /super\.save\(ctx\)/);
    assert.equal(source.match(/processDict\(result\)/g)?.length, 1);
  });

  it("keeps SaveContext constructors backward compatible while exposing collection knobs", () => {
    const source = emitJavaSaveContext("test");
    assert.match(source, /public final String collectionFormat;/);
    assert.match(source, /public final boolean useShorthand;/);
    assert.match(source, /public SaveContext\(Function<Object, Object> preSave, Function<Map<String, Object>, Map<String, Object>> postSave\)/);
    assert.match(source, /this\(preSave, postSave, "object", true\);/);
  });
});
