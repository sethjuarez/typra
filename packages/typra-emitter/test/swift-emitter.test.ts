import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Model, ModelProperty } from "@typespec/compiler";

import type { FileDecl, TypeDecl } from "../src/ir/declarations.js";
import { PropertyNode, TypeNode } from "../src/ir/ast.js";
import { TypeRegistry } from "../src/ir/expansion.js";
import { emitSwiftFile } from "../src/languages/swift/emitter.js";
import { emitSwiftProtocolScaffolds, emitSwiftRuntime } from "../src/languages/swift/scaffolding.js";
import { emitSwiftConformanceTest, emitSwiftTests } from "../src/languages/swift/test-emitter.js";
import { swiftType } from "../src/languages/swift/types.js";
import { SwiftExprVisitor } from "../src/languages/swift/visitor.js";

function typeDecl(name: string): TypeDecl {
  return {
    typeName: { namespace: "Test", name },
    base: null,
    isAbstract: false,
    isProtocol: false,
    description: "",
    fields: [],
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

function fileDecl(type: TypeDecl): FileDecl {
  return {
    typeName: type.typeName,
    types: [type],
    imports: [],
    containsAbstract: type.isAbstract,
    enums: [],
    group: "",
  };
}

function addStringField(type: TypeDecl, name: string, isOptional = false, defaultValue: string | null = null): void {
  const category = { kind: "scalar" as const, scalarType: "string" };
  type.fields.push({
    name,
    typeName: { namespace: "", name: "string" },
    category,
    isOptional,
    defaultValue,
    allowedValues: [],
    parseAliases: {},
    enumName: null,
    isOpenEnum: false,
    description: "",
    knownAs: {},
  });
  type.load.assignments.push({
    sourceName: name,
    fieldName: name,
    category,
    isOptional,
    parentTypeName: type.typeName.name,
    enumName: null,
    allowedValues: [],
    parseAliases: {},
    defaultValue,
    isOpenEnum: false,
  });
  type.save.assignments.push({
    targetName: name,
    fieldName: name,
    category,
    isOptional,
    parentTypeName: type.typeName.name,
    enumName: null,
    isOpenEnum: false,
  });
}

describe("Swift polymorphic enums", () => {
  it("declares and saves wildcard fallback cases", () => {
    const tool = typeDecl("Tool");
    tool.isAbstract = true;
    tool.polymorphicDispatch = {
      discriminatorField: "kind",
      variants: [{ value: "function", typeName: { namespace: "Test", name: "FunctionTool" } }],
      defaultVariant: {
        typeName: { namespace: "Test", name: "CustomTool" },
        isSelfReference: false,
      },
      isAbstract: true,
    };

    const source = emitSwiftFile(fileDecl(tool), new SwiftExprVisitor(), new Set(["Tool"]));
    assert.match(source, /public enum Tool: TypraModel/);
    assert.match(source, /case customTool\(CustomTool\)/);
    assert.match(source, /case unknown\(\[String: Any\]\)/);
    assert.match(source, /default: return \.customTool\(try CustomTool\.load/);
    assert.match(source, /case \.customTool\(let value\): return try value\.save/);
    assert.match(source, /case \.unknown\(let value\): return value/);
  });

  it("keeps self-reference fallbacks consistent through unknown", () => {
    const connection = typeDecl("Connection");
    connection.polymorphicDispatch = {
      discriminatorField: "kind",
      variants: [{ value: "remote", typeName: { namespace: "Test", name: "RemoteConnection" } }],
      defaultVariant: {
        typeName: connection.typeName,
        isSelfReference: true,
      },
      isAbstract: false,
    };

    const source = emitSwiftFile(fileDecl(connection), new SwiftExprVisitor(), new Set(["Connection"]));
    assert.match(source, /case unknown\(\[String: Any\]\)/);
    assert.match(source, /default: return \.unknown\(object\)/);
    assert.match(source, /case \.unknown\(let value\): return value/);
  });

  it("marks recursive polymorphic enums indirect", () => {
    const property = typeDecl("Property");
    property.polymorphicDispatch = {
      discriminatorField: "kind",
      variants: [{ value: "array", typeName: { namespace: "Test", name: "ArrayProperty" } }],
      defaultVariant: { typeName: property.typeName, isSelfReference: true },
      isAbstract: false,
    };
    const arrayProperty = typeDecl("ArrayProperty");
    arrayProperty.fields = [{
      name: "items",
      typeName: property.typeName,
      category: { kind: "complex", typeName: "Property" },
      isOptional: false,
      defaultValue: null,
      allowedValues: [],
      parseAliases: {},
      enumName: null,
      isOpenEnum: false,
      description: "",
      knownAs: {},
    }];
    const file = fileDecl(property);
    file.types.push(arrayProperty);

    const source = emitSwiftFile(file, new SwiftExprVisitor(), new Set(["Property"]));
    assert.match(source, /public indirect enum Property: TypraModel/);
  });

  it("loads explicit named collections from maps, lists, and scalar shorthand", () => {
    const tool = typeDecl("Tool");
    tool.fields = [{
      name: "bindings",
      typeName: { namespace: "Test", name: "Binding" },
      category: { kind: "collection_complex", typeName: "Binding" },
      isOptional: false,
      defaultValue: null,
      allowedValues: [],
      parseAliases: {},
      enumName: null,
      isOpenEnum: false,
      description: "",
      knownAs: {},
    }];
    tool.load.assignments = [{
      sourceName: "bindings",
      fieldName: "bindings",
      category: tool.fields[0].category,
      isOptional: false,
      parentTypeName: "Tool",
      enumName: null,
      allowedValues: [],
      parseAliases: {},
      defaultValue: null,
      isOpenEnum: false,
    }];
    tool.save.assignments = [{
      targetName: "bindings",
      fieldName: "bindings",
      category: tool.fields[0].category,
      isOptional: false,
      parentTypeName: "Tool",
      enumName: null,
      isOpenEnum: false,
    }];
    tool.collectionHelpers = [{
      propertyName: "bindings",
      elementTypeName: { namespace: "Test", name: "Binding" },
      innerFields: ["source"],
      hasNameProperty: true,
    }];

    const binding = typeDecl("Binding");
    binding.coercionProperty = "source";
    addStringField(binding, "name");
    addStringField(binding, "source");
    binding.load.coercions = [{
      scalarType: "string",
      assignments: [{ fieldName: "source", isInput: true }],
      needsDispatch: false,
    }];

    const file = fileDecl(tool);
    file.types.push(binding);
    const source = emitSwiftFile(file, new SwiftExprVisitor(), new Set());

    assert.match(source, /instance\.bindings = try loadBindings\(value, context: context\)/);
    assert.match(source, /if let values = data as\? \[Any\] \{\s+return try values\.map \{ try Binding\.load\(\$0, context: context\) \}/);
    assert.match(source, /let values = try TypraRuntime\.dictionary\(data, field: "bindings"\)/);
    assert.match(source, /var item = try Binding\.load\(value, context: context\)\s+item\.name = name/);
    assert.match(source, /if let scalar = data as\? String \{\s+var instance = Binding\(\)\s+instance\.source = try TypraRuntime\.string\(scalar, field: "source"\)/);
    assert.match(source, /result\["bindings"\] = try Self\.saveBindings\(self\.bindings, context: context\)/);
    assert.match(source, /if context\.collectionFormat == "array"/);
    assert.match(source, /let shorthand = Binding\.shorthandProperty/);
    assert.match(source, /public static let shorthandProperty: String\? = "source"/);

    const runtime = emitSwiftRuntime("Test");
    assert.match(runtime, /public let collectionFormat: String/);
    assert.match(runtime, /public let useShorthand: Bool/);
    assert.match(runtime, /public init\(collectionFormat: String = "object", useShorthand: Bool = true\)/);
  });
});

describe("Swift inherited model fields", () => {
  it("flattens base fields into derived value structs for lossless load and save", () => {
    const property = typeDecl("Property");
    addStringField(property, "kind");
    addStringField(property, "name", true);
    addStringField(property, "description", true);

    const union = typeDecl("UnionProperty");
    union.base = property.typeName;
    addStringField(union, "kind", false, "union");
    addStringField(union, "anyOf");

    const file = fileDecl(property);
    file.types.push(union);
    const source = emitSwiftFile(file, new SwiftExprVisitor(), new Set());

    assert.match(source, /public struct UnionProperty: TypraModel \{[\s\S]*public var kind: String = "union"[\s\S]*public var name: String\? = nil[\s\S]*public var description: String\? = nil[\s\S]*public var anyOf: String/);
    assert.match(source, /instance\.name = try TypraRuntime\.string\(value, field: "name"\)/);
    assert.match(source, /instance\.description = try TypraRuntime\.string\(value, field: "description"\)/);
    assert.match(source, /if let value = self\.name \{\s+result\["name"\] = value/);
    assert.match(source, /if let value = self\.description \{\s+result\["description"\] = value/);
  });
});

describe("Swift typed factory expressions", () => {
  it("wraps enum values and polymorphic payloads in their generated types", () => {
    const message = new TypeNode({} as Model, "");
    message.typeName = { namespace: "Test", name: "Message" };
    const role = new PropertyNode({} as ModelProperty, "");
    role.name = "role";
    role.typeName = { namespace: "Test", name: "string" };
    role.enumName = "Role";
    role.allowedValues = ["assistant", "user"];
    const parts = new PropertyNode({} as ModelProperty, "");
    parts.name = "parts";
    parts.typeName = { namespace: "Test", name: "ContentPart" };
    parts.isCollection = true;
    const roles = new PropertyNode({} as ModelProperty, "");
    roles.name = "roles";
    roles.typeName = { namespace: "Test", name: "Role" };
    roles.enumName = "Role";
    roles.allowedValues = ["assistant", "user"];
    roles.isCollection = true;
    const textPart = new TypeNode({} as Model, "");
    textPart.typeName = { namespace: "Test", name: "TextPart" };
    const format = new PropertyNode({} as ModelProperty, "");
    format.name = "format";
    format.typeName = { namespace: "Test", name: "string" };
    format.enumName = "TextFormat";
    format.allowedValues = ["plain", "markdown"];
    textPart.properties = [format];
    message.properties = [role, roles, parts];
    const visitor = new SwiftExprVisitor(TypeRegistry.fromTypeGraph([message, textPart]));

    const source = visitor.visitExpr({
      kind: "construct",
      typeName: message.typeName,
      fields: [
        { propertyName: "role", value: { kind: "string", value: "assistant" }, isOptional: false },
        {
          propertyName: "roles",
          value: {
            kind: "array",
            elementTypeName: { namespace: "Test", name: "Role" },
            items: [
              { kind: "string", value: "assistant" },
              { kind: "string", value: "custom" },
            ],
          },
          isOptional: false,
        },
        {
          propertyName: "parts",
          isOptional: false,
          value: {
            kind: "array",
            elementTypeName: { namespace: "Test", name: "ContentPart" },
            items: [{
              kind: "variant",
              baseTypeName: { namespace: "Test", name: "ContentPart" },
              discriminator: "kind",
              discriminatorValue: "text",
              variantTypeName: { namespace: "Test", name: "TextPart" },
              fields: [
                {
                  propertyName: "value",
                  value: { kind: "param", name: "text", paramType: "string" },
                  isOptional: false,
                },
                {
                  propertyName: "format",
                  value: { kind: "string", value: "plain" },
                  isOptional: false,
                },
              ],
            }],
          },
        },
      ],
    });

    assert.match(source, /role: \.assistant/);
    assert.match(source, /roles: \[\.assistant, \(try! Role\.parse\("custom"\)\)\]/);
    assert.match(source, /parts: \[\.textPart\(TextPart\(kind: "text", value: text, format: \.plain\)\)\]/);
  });
});

describe("Swift protocol type mapping", () => {
  it("preserves optionals, records, and collection return arity", () => {
    assert.equal(swiftType("unknown?"), "Any?");
    assert.equal(swiftType("Record<unknown>?"), "[String: Any]?");
    assert.equal(swiftType("Message[]"), "[Message]");
  });

  it("uses the same mapped signatures in protocols and compile scaffolds", () => {
    const parser = typeDecl("Parser");
    parser.isProtocol = true;
    parser.methods = [{
      name: "parse",
      returns: "Message[]",
      description: "",
      params: { data: "unknown?", context: "Record<unknown>?" },
      optional: false,
      sync: false,
    }];

    const source = emitSwiftFile(fileDecl(parser), new SwiftExprVisitor(), new Set());
    assert.match(source, /func parse\(data: Any\?, context: \[String: Any\]\?\) async throws -> \[Message\]/);

    const protocolNode = new TypeNode({} as Model, "");
    protocolNode.typeName = parser.typeName;
    protocolNode.isProtocol = true;
    protocolNode.methods = parser.methods;
    const scaffold = emitSwiftProtocolScaffolds([protocolNode], "PromptyModel");
    assert.match(scaffold, /func parse\(data: Any\?, context: \[String: Any\]\?\) async throws -> \[Message\]/);
  });
});

describe("Swift generated tests", () => {
  it("unwraps optional collections and nested models before assertions", () => {
    const modelInfo = new TypeNode({} as Model, "");
    modelInfo.typeName = { namespace: "Test", name: "ModelInfo" };
    const inputModalities = new PropertyNode({} as ModelProperty, "");
    inputModalities.name = "inputModalities";
    inputModalities.typeName = { namespace: "", name: "string" };
    inputModalities.isScalar = true;
    inputModalities.isCollection = true;
    inputModalities.isOptional = true;
    const owner = new PropertyNode({} as ModelProperty, "");
    owner.name = "owner";
    owner.typeName = { namespace: "Test", name: "FixtureOwner" };
    owner.isOptional = true;
    const ownerType = new TypeNode({} as Model, "");
    ownerType.typeName = owner.typeName;
    const ownerId = new PropertyNode({} as ModelProperty, "");
    ownerId.name = "id";
    ownerId.typeName = { namespace: "", name: "string" };
    ownerId.isScalar = true;
    ownerType.properties = [ownerId];
    owner.type = ownerType;
    modelInfo.properties = [inputModalities, owner];

    const source = emitSwiftTests({
      node: modelInfo,
      isAbstract: false,
      package: undefined,
      examples: [{
        sample: {
          inputModalities: ["text"],
          owner: { id: "owner-1" },
        },
        json: ["{}"],
        yaml: ["{}"],
        validations: [],
      }],
      coercions: [],
      factories: [],
      moduleName: "TestModels",
    });

    assert.match(source, /XCTAssertEqual\(\(try XCTUnwrap\(instance\.inputModalities\)\)\.count, 1\)/);
    assert.match(source, /XCTAssertEqual\(\(try XCTUnwrap\(instance\.owner\)\)\.id, "owner-1"\)/);
  });

  it("pattern-matches polymorphic roots before validating payload fields", () => {
    const connection = new TypeNode({} as Model, "");
    connection.typeName = { namespace: "Test", name: "Connection" };
    connection.discriminator = "kind";
    connection.isAbstract = true;
    const kind = new PropertyNode({} as ModelProperty, "");
    kind.name = "kind";
    kind.typeName = { namespace: "", name: "string" };
    kind.isScalar = true;
    connection.properties = [kind];
    const custom = new TypeNode({} as Model, "");
    custom.typeName = { namespace: "Test", name: "CustomConnection" };
    const customKind = new PropertyNode({} as ModelProperty, "");
    customKind.name = "kind";
    customKind.typeName = kind.typeName;
    customKind.isScalar = true;
    customKind.defaultValue = "custom";
    const endpoint = new PropertyNode({} as ModelProperty, "");
    endpoint.name = "endpoint";
    endpoint.typeName = { namespace: "", name: "string" };
    endpoint.isScalar = true;
    custom.properties = [customKind, endpoint];
    connection.childTypes = [custom];

    const source = emitSwiftTests({
      node: connection,
      isAbstract: true,
      package: undefined,
      examples: [{
        sample: { kind: "custom", endpoint: "https://example.test" },
        json: ["{}"],
        yaml: ["{}"],
        validations: [{ key: "kind", value: "custom", delimiter: "\"", isOptional: false }],
      }],
      coercions: [],
      factories: [],
      moduleName: "TestModels",
    });

    assert.match(source, /if case \.customConnection\(let concrete\) = instance/);
    assert.match(source, /XCTAssertEqual\(concrete\.endpoint, "https:\/\/example\.test"\)/);
    assert.doesNotMatch(source, /instance\.kind/);
  });

  it("pattern-matches wildcard children for unknown discriminator values", () => {
    const connection = new TypeNode({} as Model, "");
    connection.typeName = { namespace: "Test", name: "Connection" };
    connection.discriminator = "kind";
    connection.isAbstract = true;
    const kind = new PropertyNode({} as ModelProperty, "");
    kind.name = "kind";
    kind.typeName = { namespace: "", name: "string" };
    kind.isScalar = true;
    connection.properties = [kind];
    const fallback = new TypeNode({} as Model, "");
    fallback.typeName = { namespace: "Test", name: "FallbackConnection" };
    const fallbackKind = new PropertyNode({} as ModelProperty, "");
    fallbackKind.name = "kind";
    fallbackKind.typeName = kind.typeName;
    fallbackKind.isScalar = true;
    const endpoint = new PropertyNode({} as ModelProperty, "");
    endpoint.name = "endpoint";
    endpoint.typeName = { namespace: "", name: "string" };
    endpoint.isScalar = true;
    fallback.properties = [fallbackKind, endpoint];
    connection.childTypes = [fallback];

    const source = emitSwiftTests({
      node: connection,
      isAbstract: true,
      package: undefined,
      examples: [{
        sample: { kind: "vendor", endpoint: "https://vendor.example.test" },
        json: ["{}"],
        yaml: ["{}"],
        validations: [{ key: "kind", value: "vendor", delimiter: "\"", isOptional: false }],
      }],
      coercions: [],
      factories: [],
      moduleName: "TestModels",
    });

    assert.match(source, /if case \.fallbackConnection\(let concrete\) = instance/);
    assert.match(source, /XCTAssertEqual\(concrete\.endpoint, "https:\/\/vendor\.example\.test"\)/);
    assert.doesNotMatch(source, /instance\.kind|\.unknown/);
  });

  it("validates compound coercion values through their typed nested field", () => {
    const mode = new TypeNode({} as Model, "");
    mode.typeName = { namespace: "Test", name: "McpApprovalMode" };
    const config = new PropertyNode({} as ModelProperty, "");
    config.name = "config";
    config.typeName = { namespace: "Test", name: "McpApprovalConfig" };
    const configType = new TypeNode({} as Model, "");
    configType.typeName = config.typeName;
    configType.coercions = [{
      scalar: "string",
      expansion: { kind: "{value}" },
      title: "config",
      description: "",
      example: "always",
    }];
    const configKind = new PropertyNode({} as ModelProperty, "");
    configKind.name = "kind";
    configKind.typeName = { namespace: "", name: "string" };
    configKind.isScalar = true;
    configType.properties = [configKind];
    config.type = configType;
    mode.properties = [config];

    const source = emitSwiftTests({
      node: mode,
      isAbstract: false,
      package: undefined,
      examples: [],
      coercions: [{
        title: "mode",
        scalarType: "String",
        value: "\"always\"",
        validations: [{
          key: "config",
          value: "always",
          delimiter: "\"",
          isOptional: false,
        }],
      }],
      factories: [],
      moduleName: "TestModels",
    });

    assert.match(source, /XCTAssertEqual\(instance\.config\.kind, "always"\)/);
    assert.doesNotMatch(source, /XCTAssertEqual\(instance\.config, "always"\)/);
  });

  it("omits fixture-specific conformance references for consumer schemas", () => {
    const source = emitSwiftConformanceTest("PromptyModels");
    assert.doesNotMatch(source, /FixtureRoot|FixtureContent|WireOptions|FixtureReference/);
    assert.match(source, /testIntegerValidationRejectsUnsafeValues/);
  });
});
