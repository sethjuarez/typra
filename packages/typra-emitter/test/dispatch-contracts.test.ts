import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type DecoratorContext,
  type Interface,
  type ModelProperty,
  type Namespace,
  type Program,
  type Type,
} from "@typespec/compiler";

import { $dispatch, getStateScalar } from "../src/decorators.js";
import {
  callableContractToProtocolNode,
  collectNamespaceCallableInterfaces,
  lowerLegacyCallableContract,
  lowerTypeSpecCallableContract,
} from "../src/ir/callable.js";
import { StateKeys } from "../src/lib.js";

type Diagnostic = {
  code: string;
  message: string;
  severity: string;
  target?: unknown;
};

function createContext() {
  const maps = new Map<symbol, Map<unknown, unknown>>();
  const diagnostics: Diagnostic[] = [];
  const program = {
    stateMap(key: symbol) {
      let map = maps.get(key);
      if (!map) {
        map = new Map<unknown, unknown>();
        maps.set(key, map);
      }
      return map;
    },
    reportDiagnostic(diagnostic: Diagnostic) {
      diagnostics.push(diagnostic);
    },
  } as unknown as Program;

  return {
    context: { program } as DecoratorContext,
    program,
    diagnostics,
  };
}

/** A non-Model leaf type (a scalar) — traversal stops here. */
function scalar(name: string): Type {
  return { kind: "Scalar", name } as unknown as Type;
}

/** A Model-kinded type used for interface return types (never traversed). */
function returnType(name: string): Type {
  return { kind: "Model", name } as unknown as Type;
}

interface MockModel {
  kind: "Model";
  name: string;
  properties: Map<string, MockProperty>;
}

interface MockProperty {
  kind: "ModelProperty";
  name: string;
  type: Type;
  model: MockModel;
}

/**
 * Builds a Model whose properties preserve declaration order (Object.entries
 * over string keys is insertion-ordered), matching the deterministic traversal
 * the resolver relies on.
 */
function model(name: string, properties: Record<string, Type>): MockModel {
  const built: MockModel = { kind: "Model", name, properties: new Map() };
  for (const [propName, propType] of Object.entries(properties)) {
    built.properties.set(propName, {
      kind: "ModelProperty",
      name: propName,
      type: propType,
      model: built,
    });
  }
  return built;
}

function property(host: MockModel, field: string): ModelProperty {
  return host.properties.get(field) as unknown as ModelProperty;
}

interface OperationSpec {
  params: Record<string, Type>;
  returns?: Type;
}

function iface(
  name: string,
  operations: Record<string, OperationSpec>,
): Interface {
  const ops = new Map<string, unknown>();
  for (const [opName, spec] of Object.entries(operations)) {
    const properties = new Map<string, { type: Type }>();
    for (const [paramName, paramType] of Object.entries(spec.params)) {
      properties.set(paramName, { type: paramType });
    }
    ops.set(opName, {
      kind: "Operation",
      name: opName,
      parameters: { kind: "Model", name: "", properties },
      returnType: spec.returns ?? returnType("string"),
    });
  }
  return {
    kind: "Interface",
    name,
    namespace: {
      name: "Runtime",
      namespaces: new Map(),
      interfaces: new Map(),
      models: new Map(),
      namespace: { name: "Typra" },
    },
    operations: ops,
  } as unknown as Interface;
}

/** Shared discriminator graph: Agent -> Template -> TemplateFormat.kind. */
function dispatchGraph() {
  const format = model("TemplateFormat", {
    kind: scalar("string"),
    parser: scalar("string"),
  });
  const template = model("Template", {
    format: format as unknown as Type,
    content: scalar("string"),
  });
  const agent = model("Agent", {
    name: scalar("string"),
    template: template as unknown as Type,
  });
  const inputs = model("Inputs", { values: scalar("string") });
  return {
    format,
    template,
    agent: agent as unknown as Type,
    inputs: inputs as unknown as Type,
    discriminator: property(format, "kind"),
  };
}

describe("@dispatch decorator + IR resolution (Part II-A)", () => {
  it("records the discriminator ModelProperty on the seam interface state", () => {
    const { context, program } = createContext();
    const { agent, discriminator } = dispatchGraph();
    const renderer = iface("Renderer", { render: { params: { agent } } });

    $dispatch(context, renderer, discriminator);

    assert.equal(
      getStateScalar<ModelProperty>(
        program,
        StateKeys.dispatch,
        renderer as unknown as Type,
      ),
      discriminator,
    );
  });

  it("resolves the discriminator to a deterministic, unique access path", () => {
    const { program } = createContext();
    const { agent, inputs, discriminator } = dispatchGraph();
    const renderer = iface("Renderer", {
      render: { params: { agent, inputs } },
    });
    program.stateMap(StateKeys.dispatch).set(renderer, discriminator);

    const contract = lowerTypeSpecCallableContract(
      program,
      renderer,
      "Typra.Runtime",
      "Runtime",
    );

    assert.deepEqual(contract.dispatch, {
      discriminator: { model: "TemplateFormat", field: "kind" },
      path: "agent.template.format.kind",
    });
  });

  it("carries dispatch metadata through the TypeNode round-trip", () => {
    const { program } = createContext();
    const { agent, discriminator } = dispatchGraph();
    const renderer = iface("Renderer", { render: { params: { agent } } });
    program.stateMap(StateKeys.dispatch).set(renderer, discriminator);

    const contract = lowerTypeSpecCallableContract(
      program,
      renderer,
      "Typra.Runtime",
      "Runtime",
    );
    const node = callableContractToProtocolNode(contract);
    const legacy = lowerLegacyCallableContract(node);

    assert.deepEqual(node.dispatch, contract.dispatch);
    assert.deepEqual(legacy.dispatch, contract.dispatch);
  });

  it("diagnoses an ambiguously reachable discriminator instead of guessing", () => {
    const { program, diagnostics } = createContext();
    const { agent, template, discriminator } = dispatchGraph();
    // Both `agent.template.format.kind` and `template.format.kind` reach the
    // same discriminator property, so the path is not unique.
    const renderer = iface("Renderer", {
      render: { params: { agent, template: template as unknown as Type } },
    });
    program.stateMap(StateKeys.dispatch).set(renderer, discriminator);

    const contract = lowerTypeSpecCallableContract(
      program,
      renderer,
      "Typra.Runtime",
      "Runtime",
    );

    assert.equal(contract.dispatch, undefined);
    const diagnostic = diagnostics.find(
      (entry) => entry.code === "typra-emitter-dispatch-ambiguous",
    );
    assert.ok(diagnostic, "expected an ambiguity diagnostic");
    assert.match(diagnostic.message, /agent\.template\.format\.kind/);
    assert.match(diagnostic.message, /template\.format\.kind/);
  });

  it("diagnoses an unreachable discriminator instead of guessing", () => {
    const { program, diagnostics } = createContext();
    const { inputs, discriminator } = dispatchGraph();
    const renderer = iface("Renderer", { render: { params: { inputs } } });
    program.stateMap(StateKeys.dispatch).set(renderer, discriminator);

    const contract = lowerTypeSpecCallableContract(
      program,
      renderer,
      "Typra.Runtime",
      "Runtime",
    );

    assert.equal(contract.dispatch, undefined);
    assert.ok(
      diagnostics.some(
        (entry) => entry.code === "typra-emitter-dispatch-unreachable",
      ),
      "expected an unreachability diagnostic",
    );
  });

  it("leaves undecorated seam interfaces byte-identical (no dispatch key)", () => {
    const { program } = createContext();
    const { agent } = dispatchGraph();
    const renderer = iface("Renderer", { render: { params: { agent } } });

    const contract = lowerTypeSpecCallableContract(
      program,
      renderer,
      "Typra.Runtime",
      "Runtime",
    );

    assert.equal("dispatch" in contract, false);
  });

  it("keeps standalone ops out of the dispatch seam surface", () => {
    // `@dispatch` targets an `interface`; a bare `op` is the static
    // free-function case and never enters the callable seam surface, so it can
    // never carry dispatch metadata. Only interfaces are collected.
    const renderer = iface("Renderer", {
      render: { params: { agent: dispatchGraph().agent } },
    });
    const namespace = {
      name: "Runtime",
      interfaces: new Map([["Renderer", renderer]]),
      namespaces: new Map(),
      operations: new Map([["freeRender", { kind: "Operation", name: "freeRender" }]]),
    } as unknown as Namespace;

    const collected = collectNamespaceCallableInterfaces(namespace);

    assert.deepEqual(
      collected.map((entry) => entry.name),
      ["Renderer"],
    );
  });
});
