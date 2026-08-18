import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Model, ModelProperty } from "@typespec/compiler";

import type { EnumDef, TypeDecl } from "../src/ir/declarations.js";
import { PropertyNode, TypeNode } from "../src/ir/ast.js";
import { TypeRegistry } from "../src/ir/expansion.js";
import { javaTestOptions } from "../src/languages/java/driver.js";
import {
  emitJavaEnum,
  emitJavaFileContent,
  emitJavaMethodHelper,
  emitJavaUnknownCarrier,
  ensureJavaEditableSeamMarker,
} from "../src/languages/java/emitter.js";
import {
  emitJavaSaveContext,
  emitJavaYaml,
} from "../src/languages/java/scaffolding.js";
import { emitJavaTest } from "../src/languages/java/test-emitter.js";
import { buildBaseTestContext } from "../src/testing/test-context.js";
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
    load: {
      coercions: [],
      assignments: [],
      hasPolymorphicDispatch: false,
      hasContextHooks: true,
    },
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

    const source = emitJavaFileContent(
      [decl],
      "test",
      new JavaExprVisitor(),
      new Set(),
    );

    assert.match(source, /public String defaultValue = null;/);
    assert.match(source, /map\.containsKey\("default"\)/);
    assert.match(
      source,
      /result\.defaultValue = String\.valueOf\(map\.get\("default"\)\)/,
    );
    assert.match(
      source,
      /result\.put\("default", serializeScalar\(obj\.defaultValue\)\)/,
    );
    assert.doesNotMatch(source, /com\.fasterxml\.jackson/);
  });

  it("emits opt-in Jackson bindings from Typra load/save wire names", () => {
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

    const source = emitJavaFileContent(
      [decl],
      "test",
      new JavaExprVisitor(),
      new Set(),
      [],
      [decl],
      "jackson",
    );

    assert.match(
      source,
      /import com\.fasterxml\.jackson\.annotation\.JsonProperty;/,
    );
    assert.match(
      source,
      /@JsonSerialize\(using = KeywordModel\.TypraJacksonSerializer\.class\)/,
    );
    assert.match(
      source,
      /@JsonDeserialize\(using = KeywordModel\.TypraJacksonDeserializer\.class\)/,
    );
    assert.match(
      source,
      /@JsonProperty\("default"\)\s+@JsonInclude\(JsonInclude\.Include\.NON_NULL\)\s+public String defaultValue = null;/,
    );
    assert.match(
      source,
      /generator\.writeObject\(value == null \? null : value\.save\(new SaveContext\(\)\)\);/,
    );
    assert.match(
      source,
      /Object data = parser\.getCodec\(\)\.readValue\(parser, Object\.class\);/,
    );
    assert.match(
      source,
      /return KeywordModel\.load\(data, new LoadContext\(\)\);/,
    );
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

    const source = emitJavaFileContent(
      [decl],
      "test",
      new JavaExprVisitor(),
      new Set(),
    );
    assert.match(
      source,
      /public ApprovalModeKind mode = ApprovalModeKind\.fromValue\("always"\);/,
    );
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
      variants: [
        { value: "known", typeName: { namespace: "Test", name: "KnownTool" } },
      ],
      defaultVariant: {
        typeName: { namespace: "Test", name: "CustomTool" },
        isSelfReference: false,
      },
      isAbstract: true,
      isClosed: false,
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

    const baseSource = emitJavaFileContent(
      [base],
      "test",
      new JavaExprVisitor(),
      new Set(),
      [],
      [base, custom],
    );
    const customSource = emitJavaFileContent(
      [custom],
      "test",
      new JavaExprVisitor(),
      new Set(),
      [],
      [base, custom],
    );

    assert.doesNotMatch(baseSource, /new Tool\(\)/);
    assert.match(
      baseSource,
      /default:\s+return CustomTool\.load\(data, ctx\);/,
    );
    assert.match(baseSource, /Cannot instantiate abstract Tool/);
    assert.doesNotMatch(customSource, /public String kind/);
    assert.match(customSource, /this\.kind = "\*";/);
    assert.match(customSource, /Tool\.loadBaseInto\(result, map, ctx\);/);
    assert.doesNotMatch(customSource, /map\.containsKey\("kind"\)/);
    assert.doesNotMatch(customSource, /result\.put\("kind"/);
  });

  it("absorbs an unrecognized discriminator on an abstract open base instead of rejecting it", () => {
    const base = typeDecl([
      field("kind", "string"),
      field("label", "string", { isOptional: true }),
    ]);
    base.typeName = { namespace: "Test", name: "OpenBase" };
    base.isAbstract = true;
    base.polymorphicDispatch = {
      discriminatorField: "kind",
      variants: [
        {
          value: "managed",
          typeName: { namespace: "Test", name: "ManagedThing" },
        },
      ],
      defaultVariant: null,
      isAbstract: true,
      isClosed: false,
    };
    addAssignments(base);

    const baseSource = emitJavaFileContent(
      [base],
      "test",
      new JavaExprVisitor(),
      new Set(),
      [],
      [base],
    );
    const carrier = emitJavaUnknownCarrier(base, "test");

    // Abstract is about instantiability, not about closedness: an unrecognized kind on an open
    // base must load, so the base hands it to a concrete carrier before it can reach the throw.
    assert.match(baseSource, /return UnknownOpenBase\.load\(data, ctx\);/);
    assert.match(baseSource, /Cannot instantiate abstract OpenBase/);
    // The carrier subclasses the base, so the base must expose the payload field and the clone
    // helpers it stores through.
    assert.match(baseSource, /protected Map<String, Object> rawPayload;/);
    assert.match(
      baseSource,
      /protected static Map<String, Object> cloneRawMap\(/,
    );
    assert.match(
      baseSource,
      /obj\.rawPayload == null \? new LinkedHashMap<>\(\) : cloneRawMap\(obj\.rawPayload\)/,
    );

    assert.ok(carrier);
    assert.equal(carrier.filename, "UnknownOpenBase.java");
    assert.match(
      carrier.source,
      /public final class UnknownOpenBase extends OpenBase/,
    );
    assert.match(
      carrier.source,
      /result\.rawPayload = OpenBase\.cloneRawMap\(map\);/,
    );
    // Declared fields are loaded through loadBaseInto, so leaving them in the payload as well
    // would emit them twice.
    assert.match(carrier.source, /result\.rawPayload\.remove\("kind"\);/);
    assert.match(carrier.source, /result\.rawPayload\.remove\("label"\);/);
    assert.match(carrier.source, /OpenBase\.loadBaseInto\(result, map, ctx\);/);
  });

  it("emits no unknown carrier when a wildcard subtype or a closed discriminator already decides", () => {
    const wildcard = typeDecl([field("kind", "string")]);
    wildcard.typeName = { namespace: "Test", name: "WildcardBase" };
    wildcard.isAbstract = true;
    wildcard.polymorphicDispatch = {
      discriminatorField: "kind",
      variants: [],
      defaultVariant: {
        typeName: { namespace: "Test", name: "CustomThing" },
        isSelfReference: false,
      },
      isAbstract: true,
      isClosed: false,
    };
    addAssignments(wildcard);

    const closed = typeDecl([field("kind", "string")]);
    closed.typeName = { namespace: "Test", name: "ClosedBase" };
    closed.isAbstract = true;
    closed.polymorphicDispatch = {
      discriminatorField: "kind",
      variants: [
        {
          value: "managed",
          typeName: { namespace: "Test", name: "ManagedThing" },
        },
      ],
      defaultVariant: null,
      isAbstract: true,
      isClosed: true,
    };
    addAssignments(closed);

    const concrete = typeDecl([field("kind", "string")]);
    concrete.typeName = { namespace: "Test", name: "ConcreteBase" };
    concrete.polymorphicDispatch = {
      discriminatorField: "kind",
      variants: [
        {
          value: "managed",
          typeName: { namespace: "Test", name: "ManagedThing" },
        },
      ],
      defaultVariant: {
        typeName: { namespace: "Test", name: "ConcreteBase" },
        isSelfReference: true,
      },
      isAbstract: false,
      isClosed: false,
    };
    addAssignments(concrete);

    // A wildcard subtype already absorbs unrecognized values, a closed discriminator is meant to
    // reject them, and a non-abstract base absorbs them into itself. A carrier in any of these
    // cases would be dead code at best and would defeat the rejection at worst.
    assert.equal(emitJavaUnknownCarrier(wildcard, "test"), undefined);
    assert.equal(emitJavaUnknownCarrier(closed, "test"), undefined);
    assert.equal(emitJavaUnknownCarrier(concrete, "test"), undefined);
    // Payload visibility is uniform across every retaining class. Java forbids hiding an inherited
    // static method with weaker access, so a subclass that also retains a payload could not
    // compile against a more visible helper on its base.
    const concreteSource = emitJavaFileContent(
      [concrete],
      "test",
      new JavaExprVisitor(),
      new Set(),
      [],
      [concrete],
    );
    assert.match(concreteSource, /protected Map<String, Object> rawPayload;/);
    assert.match(
      concreteSource,
      /protected static Map<String, Object> cloneRawMap\(/,
    );
  });

  describe("Java generated tests", () => {
    it("preserves raw multiline strings for Java literal rendering", () => {
      assert.equal(
        javaTestOptions.escapeString("some \npersonal"),
        "some \npersonal",
      );
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
      const bindings = new PropertyNode(
        { name: "bindings" } as ModelProperty,
        "",
      );
      bindings.typeName = item.typeName;
      bindings.type = item;
      bindings.isCollection = true;
      bindings.isNamedCollection = true;
      container.properties = [bindings];

      const source = emitJavaTest({
        node: container,
        isAbstract: false,
        package: "test",
        examples: [
          {
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
          },
        ],
        coercions: [],
        factories: [],
      });

      assert.match(
        source,
        /assertEquals\(3, instance1\.bindings\.size\(\), "Expected bindings size"\);/,
      );
      assert.match(
        source,
        /Binding instance1Bindings0Entry = instance1\.bindings\.stream\(\)\.filter\(item -> "alpha"\.equals\(item\.name\)\)/,
      );
      assert.match(
        source,
        /assertEquals\("alpha", instance1Bindings0Entry\.name, "Expected bindings\.alpha name"\);/,
      );
      assert.match(
        source,
        /assertEquals\("text", instance1Bindings0Entry\.value, "Expected bindings\.alpha\.value"\);/,
      );
      assert.match(
        source,
        /Binding instance1Bindings1Entry = instance1\.bindings\.stream\(\)\.filter\(item -> "beta"\.equals\(item\.name\)\)/,
      );
      assert.match(
        source,
        /assertEquals\(2\.5, instance1Bindings1Entry\.weight, "Expected bindings\.beta\.weight"\);/,
      );
      assert.match(
        source,
        /Binding instance1Bindings2Entry = instance1\.bindings\.stream\(\)\.filter\(item -> "gamma"\.equals\(item\.name\)\)/,
      );
      assert.match(
        source,
        /assertEquals\("expanded", instance1Bindings2Entry\.value, "Expected instance1Bindings2Entry\.value"\);/,
      );
      assert.match(
        source,
        /assertEquals\(3, instance1Bindings2Entry\.weight, "Expected instance1Bindings2Entry\.weight"\);/,
      );
    });

    it("emits YAML control-character roundtrip assertions", () => {
      const node = new TypeNode({ name: "YamlExample" } as Model, "");
      node.typeName = { namespace: "Test", name: "YamlExample" };

      const source = emitJavaTest({
        node,
        isAbstract: false,
        package: "test",
        examples: [
          {
            sample: {},
            json: ["{}"],
            yaml: ["{}"],
            validations: [],
          },
        ],
        coercions: [],
        factories: [],
      });

      assert.match(source, /TypraYaml\.stringify\(yamlControl\)/);
      assert.match(source, /YAML should unicode-escape C0 controls/);
      assert.match(source, /TypraYaml\.parse/);
      assert.match(source, /\\\\uD83D\\\\uDE42/);
      assert.match(source, /YAML should reject unknown escapes/);
    });
  });

  describe("TypraYaml scaffolding", () => {
    it("escapes all YAML control characters and rejects unsupported escape sequences", () => {
      const source = emitJavaYaml("test");

      assert.match(
        source,
        /result\.append\(String\.format\("\\\\u%04x", \(int\) current\)\)/,
      );
      assert.match(source, /case 'b' -> result\.append\('\\b'\);/);
      assert.match(source, /case 'f' -> result\.append\('\\f'\);/);
      assert.match(source, /case 'u' -> \{/);
      assert.match(source, /throw error\("Unsupported YAML escape sequence"\)/);
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
        examples: [
          {
            sample: { nested: { kind: "string" } },
            json: ["{}"],
            yaml: ["{}"],
            validations: [],
          },
        ],
        coercions: [],
        factories: [],
      });

      assert.match(
        source,
        /StringProperty instance1NestedValue = \(StringProperty\) instance1\.nested;/,
      );
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
      const approvalProp = new PropertyNode(
        { name: "approval" } as ModelProperty,
        "",
      );
      approvalProp.name = "approval";
      approvalProp.typeName = approval.typeName;
      approvalProp.type = approval;
      container.properties = [approvalProp];

      const source = emitJavaTest({
        node: container,
        isAbstract: false,
        package: "test",
        examples: [
          {
            sample: { approval: { kind: "always" } },
            json: ["{}"],
            yaml: ["{}"],
            validations: [],
          },
        ],
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
      const formatProp = new PropertyNode(
        { name: "format" } as ModelProperty,
        "",
      );
      formatProp.typeName = format.typeName;
      formatProp.type = format;
      template.properties = [formatProp];

      const container = new TypeNode({ name: "Prompt" } as Model, "");
      container.typeName = { namespace: "Test", name: "Prompt" };
      const templateProp = new PropertyNode(
        { name: "template" } as ModelProperty,
        "",
      );
      templateProp.typeName = template.typeName;
      templateProp.type = template;
      container.properties = [templateProp];

      const source = emitJavaTest({
        node: container,
        isAbstract: false,
        package: "test",
        examples: [
          {
            sample: { template: { format: "mustache" } },
            json: ["{}"],
            yaml: ["{}"],
            validations: [],
          },
        ],
        coercions: [],
        factories: [],
      });

      assert.match(
        source,
        /assertEquals\("mustache", instance1\.template\.format\.kind, "Expected format\.kind"\);/,
      );
      assert.doesNotMatch(
        source,
        /assertEquals\("mustache", instance1\.template\.format,/,
      );
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

      const stringProperty = new TypeNode(
        { name: "StringProperty" } as Model,
        "",
      );
      stringProperty.typeName = { namespace: "Test", name: "StringProperty" };
      const childKind = new PropertyNode({ name: "kind" } as ModelProperty, "");
      childKind.typeName = { namespace: "TypeSpec", name: "string" };
      childKind.isScalar = true;
      childKind.enumName = "simpleTypes";
      childKind.allowedValues = ["string", "number"];
      childKind.defaultValue = "string";
      const priority = new PropertyNode(
        { name: "priority" } as ModelProperty,
        "",
      );
      priority.typeName = { namespace: "TypeSpec", name: "string" };
      priority.isScalar = true;
      priority.enumName = "priority";
      priority.allowedValues = ["normal", "high"];
      priority.defaultValue = "normal";
      stringProperty.properties = [childKind, priority];
      base.childTypes = [stringProperty];

      const container = new TypeNode({ name: "ObjectProperty" } as Model, "");
      container.typeName = { namespace: "Test", name: "ObjectProperty" };
      const properties = new PropertyNode(
        { name: "properties" } as ModelProperty,
        "",
      );
      properties.typeName = base.typeName;
      properties.type = base;
      properties.isCollection = true;
      container.properties = [properties];

      const source = emitJavaTest({
        node: container,
        isAbstract: false,
        package: "test",
        examples: [
          {
            sample: { properties: [{ kind: "string", priority: "normal" }] },
            json: ["{}"],
            yaml: ["{}"],
            validations: [],
          },
        ],
        coercions: [],
        factories: [],
      });

      assert.match(
        source,
        /assertEquals\("string", instance1Properties0Value\.kind, "Expected kind"\);/,
      );
      assert.doesNotMatch(source, /SimpleTypes\.fromValue\("string"\)/);
      assert.match(
        source,
        /assertEquals\(Priority\.fromValue\("normal"\), instance1Properties0Value\.priority, "Expected priority"\);/,
      );
    });
  });

  describe("Java method extension seams", () => {
    it("delegates generated model methods to a hand-editable helper", () => {
      const decl = typeDecl([]);
      decl.typeName = { namespace: "Test", name: "Message" };
      decl.methods = [
        {
          name: "text",
          returns: "string",
          description: "Render message text.",
          params: { prefix: "string" },
          optional: false,
          sync: true,
        },
      ];

      const modelSource = emitJavaFileContent(
        [decl],
        "test",
        new JavaExprVisitor(),
        new Set(),
      );
      const helper = emitJavaMethodHelper(decl, "test");

      assert.match(modelSource, /return MessageMethods\.text\(this, prefix\);/);
      assert.ok(helper);
      assert.equal(helper.filename, "MessageMethods.java");
      assert.match(helper.source, /^\/\/ <typra-editable-seam>\n/);
      assert.match(
        helper.source,
        /Typra editable seam\. This file is created once and is safe to edit\./,
      );
      assert.match(
        helper.source,
        /public static String text\(Message self, String prefix\)/,
      );
      assert.match(helper.source, /Implement Message\.text in MessageMethods/);
      assert.doesNotMatch(helper.source, /Code generated|auto-generated/);
    });

    it("adds the seam marker to helpers created before the marker contract", () => {
      const legacy = [
        "package test;",
        "",
        "public final class MessageMethods {",
        "  private MessageMethods() { }",
        "",
        "  public static String text(Message self, String prefix) {",
        "    return prefix + self.content;",
        "  }",
        "}",
        "",
      ].join("\n");

      const migrated = ensureJavaEditableSeamMarker(legacy);

      assert.ok(migrated);
      assert.match(migrated, /^\/\/ <typra-editable-seam>\n/);
      assert.match(
        migrated,
        /Typra editable seam\. This file is created once and is safe to edit\./,
      );
      // The hand-written body must survive migration untouched.
      assert.match(migrated, /return prefix \+ self\.content;/);
      assert.ok(migrated.endsWith(legacy));
    });

    it("leaves already-marked seams untouched and is idempotent", () => {
      const marked = emitJavaMethodHelper(
        (() => {
          const decl = typeDecl([]);
          decl.typeName = { namespace: "Test", name: "Message" };
          decl.methods = [
            {
              name: "text",
              returns: "string",
              description: "Render message text.",
              params: {},
              optional: false,
              sync: true,
            },
          ];
          return decl;
        })(),
        "test",
      );

      assert.ok(marked);
      assert.equal(ensureJavaEditableSeamMarker(marked.source), null);

      const migrated = ensureJavaEditableSeamMarker("package test;\n");
      assert.ok(migrated);
      assert.equal(ensureJavaEditableSeamMarker(migrated), null);
    });

    it("keeps a leading BOM at byte zero and preserves CRLF files", () => {
      const bomFile = "\uFEFFpackage test;\n\npublic final class M { }\n";
      const migratedBom = ensureJavaEditableSeamMarker(bomFile);
      assert.ok(migratedBom);
      assert.ok(migratedBom.startsWith("\uFEFF// <typra-editable-seam>"));
      // The BOM must not survive anywhere except byte zero.
      assert.equal(migratedBom.indexOf("\uFEFF", 1), -1);
      assert.equal(ensureJavaEditableSeamMarker(migratedBom), null);

      const crlfFile = "package test;\r\n\r\npublic final class M { }\r\n";
      const migratedCrlf = ensureJavaEditableSeamMarker(crlfFile);
      assert.ok(migratedCrlf);
      assert.ok(migratedCrlf.startsWith("// <typra-editable-seam>\r\n"));
      assert.doesNotMatch(migratedCrlf, /[^\r]\n/);
      assert.equal(ensureJavaEditableSeamMarker(migratedCrlf), null);
    });

    it("does not mistake the marker inside a string literal for a real seam header", () => {
      const impostor = [
        "package test;",
        "",
        "public final class MessageMethods {",
        '  static final String DOC = "// <typra-editable-seam>";',
        "}",
        "",
      ].join("\n");

      const migrated = ensureJavaEditableSeamMarker(impostor);
      assert.ok(
        migrated,
        "a marker inside a string literal must not count as a seam header",
      );
      assert.match(migrated, /^\/\/ <typra-editable-seam>\n/);
      assert.equal(ensureJavaEditableSeamMarker(migrated), null);
    });

    it("matches polymorphic discriminator wire values exactly", () => {
      const base = typeDecl([]);
      base.typeName = { namespace: "Test", name: "Tool" };
      base.polymorphicDispatch = {
        discriminatorField: "kind",
        variants: [
          {
            value: "FunctionTool",
            typeName: { namespace: "Test", name: "FunctionTool" },
          },
        ],
        defaultVariant: null,
        isAbstract: true,
        isClosed: true,
      };

      const source = emitJavaFileContent(
        [base],
        "test",
        new JavaExprVisitor(),
        new Set(["Tool"]),
      );
      assert.match(
        source,
        /discriminator instanceof String discriminatorString/,
      );
      assert.match(source, /switch \(discriminatorString\)/);
      assert.match(source, /case "FunctionTool":/);
      assert.doesNotMatch(source, /toLowerCase\(java\.util\.Locale\.ROOT\)/);
    });

    it("preserves unmodeled payload for self-referential open defaults", () => {
      const base = typeDecl([]);
      base.typeName = { namespace: "Test", name: "Connection" };
      base.fields = [
        field("kind", "string"),
        field("name", "string", { isOptional: true }),
      ];
      addAssignments(base);
      base.polymorphicDispatch = {
        discriminatorField: "kind",
        variants: [
          {
            value: "custom",
            typeName: { namespace: "Test", name: "CustomConnection" },
          },
        ],
        defaultVariant: {
          typeName: base.typeName,
          isSelfReference: true,
        },
        isAbstract: false,
        isClosed: false,
      };

      const source = emitJavaFileContent(
        [base],
        "test",
        new JavaExprVisitor(),
        new Set(["Connection"]),
      );

      assert.match(source, /protected Map<String, Object> rawPayload;/);
      assert.match(source, /result\.rawPayload = cloneRawMap\(map\);/);
      assert.match(source, /result\.rawPayload\.remove\("kind"\);/);
      assert.match(source, /result\.rawPayload\.remove\("name"\);/);
      assert.match(
        source,
        /obj\.rawPayload == null \? new LinkedHashMap<>\(\) : cloneRawMap\(obj\.rawPayload\)/,
      );
      assert.match(
        source,
        /if \(value instanceof Map<\?, \?> map\) return cloneRawMap\(map\);/,
      );
      assert.match(source, /if \(value instanceof Iterable<\?> values\)/);
    });

    it("delegates void methods without returning a value", () => {
      const decl = typeDecl([]);
      decl.typeName = { namespace: "Test", name: "Message" };
      decl.methods = [
        {
          name: "clear",
          returns: "void",
          description: "Clear the message.",
          params: {},
          optional: false,
          sync: true,
        },
      ];

      const modelSource = emitJavaFileContent(
        [decl],
        "test",
        new JavaExprVisitor(),
        new Set(),
      );
      assert.match(modelSource, /MessageMethods\.clear\(this\);/);
      assert.doesNotMatch(modelSource, /return MessageMethods\.clear/);
    });

    it("does not create method helpers for protocol interfaces", () => {
      const decl = typeDecl([]);
      decl.typeName = { namespace: "Test", name: "MessageSink" };
      decl.isProtocol = true;
      decl.methods = [
        {
          name: "emit",
          returns: "void",
          description: "Emit a message.",
          params: { value: "string" },
          optional: false,
          sync: true,
        },
      ];

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
        {
          propertyName: "mode",
          value: { kind: "string", value: "fast" },
          isOptional: false,
        },
        {
          propertyName: "count",
          value: { kind: "number", value: 1 },
          isOptional: false,
        },
        {
          propertyName: "ratio",
          value: { kind: "number", value: 1 },
          isOptional: false,
        },
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

    const source = emitJavaFileContent(
      [decl],
      "test",
      new JavaExprVisitor(),
      new Set(),
    );
    assert.match(
      source,
      /result\.mode = FactoryMode\.fromValue\(String\.valueOf\(data\)\)/,
    );
    assert.match(source, /public Long count = 1L;/);
    assert.match(source, /public Double ratio = 1\.0d;/);
  });

  it("routes integral wrappers before the single broad floating-point guard", () => {
    const kind = field("kind", "string");
    const value = field("value", "unknown");
    const decl = typeDecl([kind, value]);
    decl.load.coercions = [
      {
        scalarType: "string",
        assignments: [
          { fieldName: "kind", isInput: false, literalValue: "string" },
          { fieldName: "value", isInput: true },
        ],
        needsDispatch: false,
      },
      {
        scalarType: "boolean",
        assignments: [
          { fieldName: "kind", isInput: false, literalValue: "boolean" },
          { fieldName: "value", isInput: true },
        ],
        needsDispatch: false,
      },
      {
        scalarType: "int32",
        assignments: [
          { fieldName: "kind", isInput: false, literalValue: "integer" },
          { fieldName: "value", isInput: true },
        ],
        needsDispatch: false,
      },
      {
        scalarType: "float32",
        assignments: [
          { fieldName: "kind", isInput: false, literalValue: "float" },
          { fieldName: "value", isInput: true },
        ],
        needsDispatch: false,
      },
    ];

    const source = emitJavaFileContent(
      [decl],
      "test",
      new JavaExprVisitor(),
      new Set(),
    );
    const integralGuard =
      "data instanceof Integer || data instanceof Long || data instanceof Short || data instanceof Byte";
    assert.match(source, /if \(data instanceof String\)/);
    assert.match(source, /if \(data instanceof Boolean\)/);
    assert.match(
      source,
      new RegExp(`if \\(\\(${integralGuard.replace(/\|\|/g, "\\|\\|")}\\)\\)`),
    );
    assert.match(
      source,
      /result\.kind = "integer"[\s\S]*result\.value = \(data instanceof Number n \? n\.intValue\(\)/,
    );
    assert.match(
      source,
      /result\.kind = "float"[\s\S]*result\.value = \(data instanceof Number n \? n\.floatValue\(\)/,
    );
    assert.ok(
      source.indexOf(integralGuard) < source.indexOf("data instanceof Number"),
    );
    assert.equal(source.match(/if \(data instanceof Number\)/g)?.length, 1);
  });

  it("rejects coercions that collapse to the same Java runtime guard", () => {
    const kind = field("kind", "string");
    const value = field("value", "unknown");

    for (const [family, scalarTypes] of [
      ["integral", ["int32", "int64"]],
      ["floating-point", ["float32", "float64"]],
    ] as const) {
      const decl = typeDecl([kind, value]);
      decl.load.coercions = scalarTypes.map((scalarType) => ({
        scalarType,
        assignments: [
          { fieldName: "kind", isInput: false, literalValue: scalarType },
          { fieldName: "value", isInput: true },
        ],
        needsDispatch: false,
      }));

      assert.throws(
        () =>
          emitJavaFileContent([decl], "test", new JavaExprVisitor(), new Set()),
        new RegExp(`cannot distinguish multiple ${family} coercions`),
      );
    }
  });

  it("emits direct Java coercion tests for integral and floating wrapper families", () => {
    const node = new TypeNode({ name: "GeneratedExamples" } as Model, "");
    node.typeName = { namespace: "Test", name: "GeneratedExamples" };
    node.coercions = [
      { scalar: "int32", expansion: { kind: "integer", value: "{value}" } },
      { scalar: "float32", expansion: { kind: "float", value: "{value}" } },
      { scalar: "boolean", expansion: { kind: "boolean", value: "{value}" } },
      { scalar: "string", expansion: { kind: "string", value: "{value}" } },
    ];

    const source = emitJavaTest({
      node,
      isAbstract: false,
      package: "test",
      examples: [],
      coercions: [
        { title: "integer", scalarType: "int32", value: "7", validations: [] },
        {
          title: "float",
          scalarType: "float32",
          value: "3.5",
          validations: [],
        },
        {
          title: "boolean",
          scalarType: "boolean",
          value: "true",
          validations: [],
        },
        {
          title: "string",
          scalarType: "string",
          value: '"hello"',
          validations: [],
        },
      ],
      factories: [],
    });

    assert.match(source, /GeneratedExamples\.load\(42, new LoadContext\(\)\)/);
    assert.match(source, /GeneratedExamples\.load\(42L, new LoadContext\(\)\)/);
    assert.match(
      source,
      /GeneratedExamples\.load\(3\.14, new LoadContext\(\)\)/,
    );
    assert.match(
      source,
      /GeneratedExamples\.load\(3\.14f, new LoadContext\(\)\)/,
    );
    assert.match(
      source,
      /GeneratedExamples\.load\(true, new LoadContext\(\)\)/,
    );
    assert.match(
      source,
      /GeneratedExamples\.load\("hello", new LoadContext\(\)\)/,
    );
    assert.match(source, /GeneratedExamples\.fromJson\(/);
    assert.match(source, /GeneratedExamples\.fromYaml\(/);
  });

  it("uses typed enum values in direct scalar-coercion load assertions", () => {
    const node = new TypeNode({ name: "McpApprovalMode" } as Model, "");
    node.typeName = { namespace: "Test", name: "McpApprovalMode" };
    node.coercions = [
      { scalar: "string", expansion: { kind: "{value}" }, example: "never" },
    ];
    const kind = new PropertyNode({ name: "kind" } as ModelProperty, "");
    kind.name = "kind";
    kind.typeName = { namespace: "TypeSpec", name: "string" };
    kind.isScalar = true;
    kind.enumName = "mcpApprovalModeKind";
    kind.allowedValues = ["never", "always"];
    node.properties = [kind];

    const source = emitJavaTest(
      buildBaseTestContext(node, "test", javaTestOptions),
    );

    // The fromJson/fromYaml coercion assertions already wrap in the enum type.
    assert.match(
      source,
      /assertEquals\(McpApprovalModeKind\.fromValue\("never"\), coercedJson1\.kind,/,
    );
    // The direct load(<scalar>) coercion assertion must ALSO use the typed enum,
    // not a bare String literal that can never .equals() the enum instance.
    assert.match(
      source,
      /McpApprovalMode\.load\("never", new LoadContext\(\)\)/,
    );
    assert.match(
      source,
      /assertEquals\(McpApprovalModeKind\.fromValue\("never"\), coerced1_1\.kind,/,
    );
    assert.doesNotMatch(source, /assertEquals\("never", coerced1_1\.kind,/);
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

    const source = emitJavaFileContent(
      [decl],
      "test",
      new JavaExprVisitor(),
      new Set(),
    );
    assert.match(source, /public List<String> items = null;/);
    assert.match(
      source,
      /public ApprovalMode mode = ApprovalMode\.fromValue\("always"\);/,
    );
    assert.match(
      source,
      /public List<ApprovalMode> modes = new ArrayList<>\(\);/,
    );
  });

  it("loads and saves explicit named collection maps, lists, and shorthand", () => {
    const bindings = field("bindings", "Binding", {
      typeName: { namespace: "Test", name: "Binding" },
      category: { kind: "collection_complex", typeName: "Binding" },
    });
    const decl = typeDecl([bindings]);
    decl.collectionHelpers = [
      {
        propertyName: "bindings",
        elementTypeName: bindings.typeName,
        innerFields: ["source"],
        hasNameProperty: true,
      },
    ];
    addAssignments(decl);

    const source = emitJavaFileContent(
      [decl],
      "test",
      new JavaExprVisitor(),
      new Set(),
    );
    assert.match(
      source,
      /map\.get\("bindings"\) instanceof Map<\?, \?> values/,
    );
    assert.match(
      source,
      /if \(entry\.getValue\(\) instanceof Iterable<\?>\) \{[\s\S]*invalid named collection entry category array/,
    );
    assert.match(
      source,
      /itemData\.put\("name", String\.valueOf\(entry\.getKey\(\)\)\);\s+Binding item = Binding\.load\(itemData, ctx\.at\("bindings"\)\.at\(String\.valueOf\(entry\.getKey\(\)\)\)\);/,
    );
    assert.match(
      source,
      /else if \(map\.get\("bindings"\) instanceof Iterable<\?> values\)/,
    );
    assert.match(
      source,
      /String itemName = item\.name;\s+itemNames\.add\(itemName\);\s+if \(itemName == null \|\| itemName\.isEmpty\(\) \|\| !names\.add\(itemName\)\) canUseObject = false;/,
    );
    assert.match(
      source,
      /if \("array"\.equals\(ctx\.collectionFormat\) \|\| !canUseObject\)/,
    );
    assert.match(
      source,
      /String itemName = itemNames\.get\(index\);\s+itemData\.remove\("name"\);/,
    );
    assert.match(
      source,
      /ctx\.useShorthand && Binding\.SHORTHAND_PROPERTY != null/,
    );
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

    const source = emitJavaFileContent(
      [child],
      "test",
      new JavaExprVisitor(),
      new Set(),
      [],
      [base, child],
    );
    assert.match(
      source,
      /obj\.saveFields\(result, ctx\);\s+return ctx\.processDict\(result\);/,
    );
    assert.match(
      source,
      /protected void saveFields\(Map<String, Object> result, SaveContext ctx\) \{\s+super\.saveFields\(result, ctx\);/,
    );
    assert.doesNotMatch(source, /super\.save\(ctx\)/);
    assert.equal(source.match(/processDict\(result\)/g)?.length, 1);
  });

  it("keeps SaveContext constructors backward compatible while exposing collection knobs", () => {
    const source = emitJavaSaveContext("test");
    assert.match(source, /public final String collectionFormat;/);
    assert.match(source, /public final boolean useShorthand;/);
    assert.match(
      source,
      /public SaveContext\(Function<Object, Object> preSave, Function<Map<String, Object>, Map<String, Object>> postSave\)/,
    );
    assert.match(source, /this\(preSave, postSave, "object", true\);/);
  });
});

describe("Java provider wire mapping", () => {
  function wireDecl(): TypeDecl {
    const decl = typeDecl([
      field("maxOutputTokens", "string", { isOptional: true }),
      field("temperature", "string", { isOptional: true }),
    ]);
    addAssignments(decl);
    decl.wire = {
      providers: ["openai", "anthropic"],
      mappings: [
        {
          fieldName: "maxOutputTokens",
          category: { kind: "scalar", scalarType: "string" },
          isOptional: true,
          parentTypeName: decl.typeName.name,
          wireNames: {
            openai: "max_completion_tokens",
            anthropic: "max_tokens",
          },
        },
        {
          fieldName: "temperature",
          category: { kind: "scalar", scalarType: "string" },
          isOptional: true,
          parentTypeName: decl.typeName.name,
          wireNames: { openai: "temperature" },
        },
      ],
    } as TypeDecl["wire"];
    return decl;
  }

  it("omits fields the requested provider does not map", () => {
    // Every other backend keys emission on the provider having a mapping. Seeding wireName with
    // the schema field name leaked unmapped fields, including for a null or empty provider.
    const source = emitJavaFileContent(
      [wireDecl()],
      "test",
      new JavaExprVisitor(),
      new Set(),
    );

    assert.match(source, /String wireName = null;/);
    assert.doesNotMatch(source, /String wireName = "temperature";/);
    assert.doesNotMatch(source, /boolean include/);
    assert.match(
      source,
      /if \(wireName != null && this\.temperature != null\)/,
    );
  });

  it("still emits fields the requested provider does map", () => {
    // Counterpart guard: omission must key on the missing mapping, not disable wire mapping.
    const source = emitJavaFileContent(
      [wireDecl()],
      "test",
      new JavaExprVisitor(),
      new Set(),
    );

    assert.match(
      source,
      /if \(target\.equals\("openai"\)\) \{ wireName = "max_completion_tokens";/,
    );
    assert.match(
      source,
      /if \(target\.equals\("anthropic"\)\) \{ wireName = "max_tokens";/,
    );
    assert.match(
      source,
      /if \(target\.equals\("openai"\)\) \{ wireName = "temperature";/,
    );
  });
});
