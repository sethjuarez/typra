import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Model, ModelProperty } from "@typespec/compiler";

import { buildExportSurfaceSnapshot } from "../src/contract-surface.js";
import { TypeNode, PropertyNode } from "../src/ir/ast.js";
import { lowerFile, lowerType } from "../src/ir/lower.js";
import { TypeRegistry } from "../src/ir/expansion.js";
import { emitTypeScriptFile } from "../src/languages/typescript/emitter.js";
import { TypeScriptExprVisitor } from "../src/languages/typescript/visitor.js";
import { emitPythonFile } from "../src/languages/python/emitter.js";
import { PythonExprVisitor } from "../src/languages/python/visitor.js";

type PromptyCompatibilityGraph = {
  registry: TypeRegistry;
  prompty: TypeNode;
  property: TypeNode;
  contentPart: TypeNode;
  modelOptions: TypeNode;
  toolResult: TypeNode;
  renderer: TypeNode;
  parser: TypeNode;
};

// Representative consumer evidence from Prompty. These fixtures preserve
// compatibility-critical behavior without making Prompty's current design the
// normative Typra v2 contract model.
function makeType(
  name: string,
  properties: PropertyNode[] = [],
  options: Partial<TypeNode> = {},
): TypeNode {
  const node = new TypeNode({} as Model, `Prompty compatibility ${name}`);
  node.typeName = { namespace: "Prompty", name };
  node.properties = properties;
  Object.assign(node, options);
  return node;
}

function makeProp(
  name: string,
  typeName: string,
  options: Partial<PropertyNode> = {},
): PropertyNode {
  const prop = new PropertyNode({} as ModelProperty, `Prompty ${name}`);
  prop.name = name;
  prop.typeName = { namespace: "Prompty", name: typeName };
  prop.isScalar = [
    "string",
    "boolean",
    "int32",
    "int64",
    "float32",
    "float64",
    "integer",
    "unknown",
  ].includes(typeName);
  Object.assign(prop, options);
  return prop;
}

function buildPromptyCompatibilityGraph(): PromptyCompatibilityGraph {
  const property = makeType(
    "Property",
    [
      makeProp("name", "string"),
      makeProp("kind", "string", {
        allowedValues: ["string", "integer", "float", "boolean"],
        parseAliases: { string: ["text"] },
        enumName: "PropertyKind",
      }),
      makeProp("default", "unknown"),
      makeProp("example", "unknown", { isOptional: true }),
    ],
    {
      discriminator: "kind",
      entryShorthand: "default",
      coercions: [
        { scalar: "string", expansion: { kind: "string", example: "{value}" } },
        {
          scalar: "integer",
          expansion: { kind: "integer", example: "{value}" },
        },
        { scalar: "float32", expansion: { kind: "float", example: "{value}" } },
        {
          scalar: "boolean",
          expansion: { kind: "boolean", example: "{value}" },
        },
      ],
    },
  );

  const textPart = makeType(
    "TextPart",
    [
      makeProp("kind", "string", { defaultValue: "text" }),
      makeProp("text", "string"),
    ],
    {
      base: { namespace: "Prompty", name: "ContentPart" },
    },
  );
  const contentPart = makeType(
    "ContentPart",
    [makeProp("kind", "string", { allowedValues: ["text"] })],
    {
      discriminator: "kind",
      childTypes: [textPart],
    },
  );

  const modelOptions = makeType("ModelOptions", [
    makeProp("maxOutputTokens", "int32", {
      isOptional: true,
      knownAs: [
        { provider: "openai", name: "max_completion_tokens" },
        { provider: "anthropic", name: "max_tokens" },
      ],
    }),
    makeProp("temperature", "float32", {
      isOptional: true,
      knownAs: [{ provider: "openai", name: "temperature" }],
      defaultFor: [{ provider: "openai", defaultValue: 0.2 }],
    }),
  ]);

  const inputs = makeProp("inputs", "Property", {
    isCollection: true,
    isNamedCollection: true,
    type: property,
  });
  const outputs = makeProp("outputs", "Property", {
    isCollection: true,
    isNamedCollection: true,
  });
  const messages = makeProp("messages", "ContentPart", {
    isCollection: true,
    type: contentPart,
  });
  const prompty = makeType("Prompty", [
    makeProp("name", "string"),
    inputs,
    outputs,
    messages,
    makeProp("options", "ModelOptions", { type: modelOptions }),
  ]);

  const toolResult = makeType(
    "ToolResult",
    [
      makeProp("kind", "string", { defaultValue: "text" }),
      makeProp("value", "string"),
    ],
    {
      factories: [
        {
          name: "text",
          sets: { kind: "text", value: "{value}" },
          params: { value: "string" },
        },
      ],
    },
  );

  const renderer = makeType("Renderer", [], {
    isProtocol: true,
    methods: [
      {
        name: "render",
        returns: "string",
        description: "Render a Prompty document with runtime inputs.",
        params: { prompty: "Prompty", inputs: "Record<unknown>" },
        optional: false,
        sync: false,
        runtimeCancellable: true,
        atomic: false,
        nonFatal: false,
      },
    ],
  });
  const parser = makeType("Parser", [], {
    isProtocol: true,
    methods: [
      {
        name: "parse",
        returns: "Prompty",
        description: "Parse a Prompty document.",
        params: { source: "string" },
        optional: false,
        sync: true,
        runtimeCancellable: false,
        atomic: false,
        nonFatal: false,
      },
    ],
  });

  const registry = TypeRegistry.fromTypeGraph([
    prompty,
    property,
    contentPart,
    textPart,
    modelOptions,
    toolResult,
    renderer,
    parser,
  ]);

  return {
    registry,
    prompty,
    property,
    contentPart,
    modelOptions,
    toolResult,
    renderer,
    parser,
  };
}

describe("Prompty compatibility baseline for Typra v2", () => {
  it("keeps the current Typra-dependent load/save contract explicit in lowered IR", () => {
    const graph = buildPromptyCompatibilityGraph();
    const prompty = lowerType(graph.prompty, graph.registry, new Set());
    const helpers = new Map(
      prompty.collectionHelpers.map((helper) => [helper.propertyName, helper]),
    );

    assert.deepEqual(
      prompty.load.assignments.map((assignment) => assignment.sourceName),
      ["name", "inputs", "outputs", "messages", "options"],
    );
    assert.deepEqual(
      prompty.save.assignments.map((assignment) => assignment.targetName),
      ["name", "inputs", "outputs", "messages", "options"],
    );

    assert.equal(helpers.get("inputs")?.hasNameProperty, true);
    assert.equal(helpers.get("outputs")?.hasNameProperty, true);
    assert.equal(helpers.get("inputs")?.entryShorthand?.valueField, "default");
    assert.deepEqual(helpers.get("inputs")?.entryShorthand?.cases[0], {
      scalarType: "string",
      assignments: [{ fieldName: "kind", literalValue: "string" }],
    });
    assert.deepEqual(helpers.get("inputs")?.innerFields, [
      "kind",
      "default",
      "example",
    ]);
  });

  it("covers discriminators, provider wire mappings, factories, methods, and protocols", () => {
    const graph = buildPromptyCompatibilityGraph();
    const contentPart = lowerType(graph.contentPart, graph.registry, new Set());
    const modelOptions = lowerType(graph.modelOptions, graph.registry, new Set());
    const property = lowerType(graph.property, graph.registry, new Set());
    const toolResult = lowerType(graph.toolResult, graph.registry, new Set());
    const renderer = lowerType(graph.renderer, graph.registry, new Set());

    assert.deepEqual(contentPart.polymorphicDispatch?.variants, [
      { value: "text", typeName: { namespace: "Prompty", name: "TextPart" } },
    ]);
    assert.equal(contentPart.polymorphicDispatch?.discriminatorField, "kind");

    assert.deepEqual(modelOptions.wire?.providers, ["anthropic", "openai"]);
    assert.deepEqual(modelOptions.wire?.mappings[0].wireNames, {
      openai: "max_completion_tokens",
      anthropic: "max_tokens",
    });

    const kindField = property.fields.find((field) => field.name === "kind");
    assert.deepEqual(kindField?.parseAliases, { string: ["text"] });
    assert.deepEqual(
      property.load.assignments.find((assignment) => assignment.fieldName === "kind")
        ?.parseAliases,
      { string: ["text"] },
    );

    assert.equal(toolResult.factories[0].name, "text");
    assert.deepEqual(toolResult.factories[0].params, { value: "string" });

    assert.equal(renderer.isProtocol, true);
    assert.deepEqual(renderer.methods, [
      {
        name: "render",
        returns: "string",
        description: "Render a Prompty document with runtime inputs.",
        params: { prompty: "Prompty", inputs: "Record<unknown>" },
        optional: false,
        sync: false,
        runtimeCancellable: true,
        atomic: false,
        nonFatal: false,
      },
    ]);
  });

  it("keeps representative TypeScript and Python generated surfaces stable", () => {
    const graph = buildPromptyCompatibilityGraph();
    const promptyFile = lowerFile(graph.prompty, graph.registry, new Set());
    const optionsFile = lowerFile(graph.modelOptions, graph.registry, new Set());
    const propertyFile = lowerFile(graph.property, graph.registry, new Set());
    const rendererFile = lowerFile(graph.renderer, graph.registry, new Set());

    const typeScript = emitTypeScriptFile(
      promptyFile,
      new TypeScriptExprVisitor(graph.registry),
    );
    const typeScriptWire = emitTypeScriptFile(
      optionsFile,
      new TypeScriptExprVisitor(graph.registry),
    );
    const typeScriptProperty = emitTypeScriptFile(
      propertyFile,
      new TypeScriptExprVisitor(graph.registry),
    );
    const pythonProtocol = emitPythonFile(
      rendererFile,
      new PythonExprVisitor(graph.registry),
    );

    assert.match(typeScript, /static load\(data: Record<string, unknown>/);
    assert.match(typeScript, /save\(context\?: SaveContext\)/);
    assert.match(typeScript, /static loadInputs/);
    assert.match(typeScript, /static saveInputs/);
    assert.match(typeScript, /"kind": "string", "default": v/);
    assert.doesNotMatch(typeScript, /"example": v/);
    assert.match(typeScriptWire, /toWire\(provider: string\)/);
    assert.match(typeScriptWire, /max_completion_tokens/);
    assert.match(typeScriptProperty, /case "text":\s+return "string";/);
    assert.match(
      pythonProtocol,
      /async def render_async\(self, prompty: Prompty, inputs: dict\[str, Any\], cancellation: CancellationToken \| None = None\) -> str:/,
    );
    assert.match(
      pythonProtocol,
      /raise NotImplementedError[\s\S]*async def render_async[\s\S]*raise NotImplementedError/,
    );
  });

  it("exports legacy callable compatibility surfaces without treating them as transport", () => {
    const graph = buildPromptyCompatibilityGraph();
    const snapshot = buildExportSurfaceSnapshot(
      "Prompty.Prompty",
      "Prompty",
      "Prompty",
      [{ type: "TypeScript" }, { type: "Python" }],
      [
        graph.prompty,
        graph.modelOptions,
        graph.property,
        graph.contentPart,
        graph.toolResult,
        graph.renderer,
        graph.parser,
      ],
    );

    for (const target of snapshot.targets) {
      assert.deepEqual(
        target.protocols.map((protocol) => protocol.name),
        ["Parser", "Renderer"],
      );
      assert.deepEqual(
        target.protocols.flatMap((protocol) =>
          protocol.methods.map((method) => method.name),
        ),
        ["parse", "render"],
      );
      assert.ok(
        !target.modules.some((moduleName) =>
          /http|fastapi|route|controller/i.test(moduleName),
        ),
      );
    }
  });
});
