import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Model, ModelProperty } from "@typespec/compiler";

import type { FileDecl, TypeDecl } from "../src/ir/declarations.js";
import { PropertyNode, TypeNode } from "../src/ir/ast.js";
import { TypeRegistry } from "../src/ir/expansion.js";
import { emitSwiftFile } from "../src/languages/swift/emitter.js";
import { emitSwiftProtocolScaffolds } from "../src/languages/swift/scaffolding.js";
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
    assert.match(source, /default: return \.customTool\(try CustomTool\.load/);
    assert.match(source, /case \.customTool\(let value\): return try value\.save/);
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
