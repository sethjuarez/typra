import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Interface, Model, Program, Type } from "@typespec/compiler";

import { TypeNode } from "../src/ir/ast.js";
import {
  callableContractToProtocolNode,
  lowerLegacyCallableContract,
  lowerLegacyCallableContracts,
  lowerTypeSpecCallableContract,
} from "../src/ir/callable.js";
import { lowerType } from "../src/ir/lower.js";
import { TypeRegistry } from "../src/ir/expansion.js";
import { StateKeys } from "../src/lib.js";

function protocol(name: string, group = "pipeline"): TypeNode {
  const node = new TypeNode({} as Model, `Callable ${name}`);
  node.typeName = { namespace: "Typra.Fixtures", name };
  node.group = group;
  node.isProtocol = true;
  node.methods = [
    {
      name: "render",
      returns: "RenderResult",
      description: "Render with handwritten runtime behavior.",
      params: { request: "RenderRequest", context: "RenderContext" },
      optional: false,
      sync: false,
      runtimeCancellable: true,
      atomic: false,
      nonFatal: true,
    },
    {
      name: "format",
      returns: "Message[]",
      description: "Format messages without async scheduling.",
      params: { messages: "Message[]" },
      optional: true,
      sync: true,
      runtimeCancellable: false,
      atomic: true,
      nonFatal: false,
    },
  ];
  return node;
}

function type(name: string): Type {
  return {
    kind: "Model",
    name,
  } as unknown as Type;
}

function nativeInterface(
  includeReset = true,
  effects: Map<string, unknown> = new Map(),
): { program: Program; iface: Interface } {
  const operations = new Map<string, unknown>([
    [
      "render",
      {
        kind: "Operation",
        name: "render",
        parameters: {
          kind: "Model",
          name: "",
          properties: new Map([
            ["request", { type: type("RenderRequest") }],
            ["context", { type: type("RenderContext") }],
          ]),
        },
        returnType: type("RenderResult"),
      },
    ],
  ]);
  if (includeReset) {
    operations.set("reset", {
      kind: "Operation",
      name: "reset",
      parameters: {
        kind: "Model",
        name: "",
        properties: new Map(),
      },
      returnType: {
        kind: "Intrinsic",
        name: "void",
      },
    });
  }
  const iface = {
    kind: "Interface",
    name: "Renderer",
    namespace: {
      name: "Runtime",
      namespaces: new Map(),
      interfaces: new Map(),
      models: new Map(),
      namespace: {
        name: "Typra",
      },
    },
    operations,
  } as unknown as Interface;
  const docs = new Map<unknown, { value: string }>([
    [iface, { value: "Render callable contract." }],
    [Array.from(iface.operations.values())[0], { value: "Render a request." }],
  ]);
  const operationEffects = new Map<unknown, unknown>();
  for (const [name, effect] of effects) {
    const operation = operations.get(name);
    if (operation) {
      operationEffects.set(operation, effect);
    }
  }
  const program = {
    stateMap: (key: symbol) =>
      key === StateKeys.operationEffects ? operationEffects : docs,
  } as unknown as Program;

  return { program, iface };
}

describe("callable-contract IR", () => {
  it("represents legacy @protocol/@method metadata without losing information", () => {
    const renderer = protocol("Renderer");
    const contract = lowerLegacyCallableContract(renderer);

    assert.deepEqual(contract, {
      name: "Renderer",
      namespace: "Typra.Fixtures",
      group: "pipeline",
      description: "Callable Renderer",
      source: {
        kind: "legacy-protocol-model",
        namespace: "Typra.Fixtures",
        symbol: "Renderer",
        group: "pipeline",
      },
      hydration: {
        seamKind: "protocol-adapter",
        implementation: "handwritten",
        generatedBoundary: "interface",
      },
      operations: [
        {
          name: "format",
          returns: "Message[]",
          description: "Format messages without async scheduling.",
          params: { messages: "Message[]" },
          optional: true,
          sync: true,
          runtimeCancellable: false,
          atomic: true,
          nonFatal: false,
          source: {
            kind: "legacy-protocol-model",
            namespace: "Typra.Fixtures",
            symbol: "Renderer",
            group: "pipeline",
          },
        },
        {
          name: "render",
          returns: "RenderResult",
          description: "Render with handwritten runtime behavior.",
          params: { context: "RenderContext", request: "RenderRequest" },
          optional: false,
          sync: false,
          runtimeCancellable: true,
          atomic: false,
          nonFatal: true,
          source: {
            kind: "legacy-protocol-model",
            namespace: "Typra.Fixtures",
            symbol: "Renderer",
            group: "pipeline",
          },
        },
      ],
    });
  });

  it("matches existing method lowering semantics for legacy protocol declarations", () => {
    const renderer = protocol("Renderer");
    const registry = TypeRegistry.fromTypeGraph([renderer]);
    const typeDecl = lowerType(renderer, registry, new Set());
    const callable = lowerLegacyCallableContract(renderer);
    const renderOperation = callable.operations.find(
      (operation) => operation.name === "render",
    );
    const renderMethod = typeDecl.methods.find(
      (method) => method.name === "render",
    );

    assert.deepEqual(
      callable.operations.map((operation) => ({
        name: operation.name,
        returns: operation.returns,
        params: operation.params,
        optional: operation.optional,
        sync: operation.sync,
        runtimeCancellable: operation.runtimeCancellable,
        atomic: operation.atomic,
        nonFatal: operation.nonFatal,
      })),
      typeDecl.methods
        .map((method) => ({
          name: method.name,
          returns: method.returns,
          params: method.params,
          optional: method.optional,
          sync: method.sync,
          runtimeCancellable: method.runtimeCancellable,
          atomic: method.atomic,
          nonFatal: method.nonFatal,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    );
    assert.deepEqual(Object.keys(renderOperation?.params ?? {}), [
      "request",
      "context",
    ]);
    assert.deepEqual(
      Object.keys(renderOperation?.params ?? {}),
      Object.keys(renderMethod?.params ?? {}),
    );
  });

  it("sorts callable contracts by group and name for stable downstream consumers", () => {
    const zeta = protocol("Zeta", "runtime");
    const alpha = protocol("Alpha", "pipeline");
    const beta = protocol("Beta", "pipeline");

    assert.deepEqual(
      lowerLegacyCallableContracts([zeta, beta, alpha]).map((contract) => ({
        group: contract.group,
        name: contract.name,
      })),
      [
        { group: "pipeline", name: "Alpha" },
        { group: "pipeline", name: "Beta" },
        { group: "runtime", name: "Zeta" },
      ],
    );
  });

  it("lowers TypeSpec-native interface/op into the same callable contract shape", () => {
    const { program, iface } = nativeInterface();
    const contract = lowerTypeSpecCallableContract(
      program,
      iface,
      "Typra.Runtime",
      "Runtime",
    );

    assert.equal(contract.source.kind, "typespec-interface");
    assert.equal(contract.name, "Renderer");
    assert.equal(contract.namespace, "Typra.Runtime");
    assert.equal(contract.description, "Render callable contract.");
    assert.deepEqual(
      contract.operations.map((operation) => ({
        name: operation.name,
        returns: operation.returns,
        params: operation.params,
      })),
      [
        {
          name: "render",
          returns: "RenderResult",
          params: { request: "RenderRequest", context: "RenderContext" },
        },
        { name: "reset", returns: "void", params: {} },
      ],
    );
    assert.deepEqual(Object.keys(contract.operations[0].params), [
      "request",
      "context",
    ]);
  });

  it("projects TypeSpec-native callable contracts as protocol nodes for target renderers", () => {
    const { program, iface } = nativeInterface();
    const contract = lowerTypeSpecCallableContract(
      program,
      iface,
      "Typra.Runtime",
      "Runtime",
    );
    const node = callableContractToProtocolNode(contract);
    const registry = TypeRegistry.fromTypeGraph([node]);
    const typeDecl = lowerType(node, registry, new Set());

    assert.equal(node.isProtocol, true);
    assert.deepEqual(
      typeDecl.methods.map((method) => ({
        name: method.name,
        returns: method.returns,
        params: method.params,
      })),
      [
        {
          name: "render",
          returns: "RenderResult",
          params: { request: "RenderRequest", context: "RenderContext" },
        },
        { name: "reset", returns: "void", params: {} },
      ],
    );
  });

  it("proves equivalent legacy and TypeSpec-native callables lower to equivalent IR", () => {
    const legacyNode = protocol("Renderer");
    legacyNode.typeName = { namespace: "Typra.Runtime", name: "Renderer" };
    legacyNode.methods = [
      {
        name: "render",
        returns: "RenderResult",
        description: "Render a request.",
        params: { request: "RenderRequest", context: "RenderContext" },
        optional: false,
        sync: false,
        runtimeCancellable: false,
        atomic: false,
        nonFatal: false,
      },
    ];
    const legacy = lowerLegacyCallableContract(legacyNode);
    const { program, iface } = nativeInterface(false);
    const native = lowerTypeSpecCallableContract(
      program,
      iface,
      "Typra.Runtime",
      "Runtime",
    );

    assert.deepEqual(
      {
        name: native.name,
        namespace: native.namespace,
        hydration: native.hydration,
        operations: native.operations.map((operation) => ({
          name: operation.name,
          returns: operation.returns,
          description: operation.description,
          params: operation.params,
          optional: operation.optional,
          sync: operation.sync,
          runtimeCancellable: operation.runtimeCancellable,
          atomic: operation.atomic,
          nonFatal: operation.nonFatal,
        })),
      },
      {
        name: legacy.name,
        namespace: legacy.namespace,
        hydration: legacy.hydration,
        operations: legacy.operations.map((operation) => ({
          name: operation.name,
          returns: operation.returns,
          description: operation.description,
          params: operation.params,
          optional: operation.optional,
          sync: operation.sync,
          runtimeCancellable: operation.runtimeCancellable,
          atomic: operation.atomic,
          nonFatal: operation.nonFatal,
        })),
      },
    );
  });

  it("lowers TypeSpec-native operation decorators into callable effect metadata", () => {
    const legacyNode = protocol("Renderer");
    legacyNode.typeName = { namespace: "Typra.Runtime", name: "Renderer" };
    legacyNode.methods = [
      {
        name: "render",
        returns: "RenderResult",
        description: "Render a request.",
        params: { request: "RenderRequest", context: "RenderContext" },
        optional: true,
        sync: true,
        runtimeCancellable: true,
        atomic: true,
        nonFatal: true,
      },
    ];
    const legacy = lowerLegacyCallableContract(legacyNode);
    const { program, iface } = nativeInterface(
      false,
      new Map([
        [
          "render",
          {
            optional: true,
            sync: true,
            runtimeCancellable: true,
            atomic: true,
            nonFatal: true,
          },
        ],
      ]),
    );
    const native = lowerTypeSpecCallableContract(
      program,
      iface,
      "Typra.Runtime",
      "Runtime",
    );

    assert.deepEqual(
      native.operations.map((operation) => ({
        name: operation.name,
        optional: operation.optional,
        sync: operation.sync,
        runtimeCancellable: operation.runtimeCancellable,
        atomic: operation.atomic,
        nonFatal: operation.nonFatal,
      })),
      legacy.operations.map((operation) => ({
        name: operation.name,
        optional: operation.optional,
        sync: operation.sync,
        runtimeCancellable: operation.runtimeCancellable,
        atomic: operation.atomic,
        nonFatal: operation.nonFatal,
      })),
    );
  });
});
