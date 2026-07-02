import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { type DecoratorContext, type Program, type Type } from "@typespec/compiler";

import {
  $abstract,
  $coerce,
  $defaultFor,
  $factory,
  $knownAs,
  $method,
  $parseAlias,
  $protocol,
  $sample,
  appendStateValue,
  getStateScalar,
  getStateValue,
  setStateScalar,
} from "../src/decorators.js";
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

describe("decorator state helpers", () => {
  it("appends scalar and array state values in insertion order", () => {
    const { context, program } = createContext();
    const target = { kind: "Model", name: "Fixture" } as Type;
    const key = Symbol("state");

    appendStateValue(context, key, target, "first");
    appendStateValue(context, key, target, ["second", "third"]);

    assert.deepEqual(getStateValue(program, key, target), ["first", "second", "third"]);
  });

  it("stores scalar state and treats absent values as undefined", () => {
    const { context, program } = createContext();
    const target = { kind: "Model", name: "Fixture" } as Type;
    const key = Symbol("scalar");

    assert.equal(getStateScalar(program, key, target), undefined);
    setStateScalar(context, key, target, true);

    assert.equal(getStateScalar(program, key, target), true);
  });
});

describe("TypeSpec decorators", () => {
  it("records plain object samples and rejects samples missing the target property", () => {
    const { context, program, diagnostics } = createContext();
    const property = { kind: "ModelProperty", name: "name" } as Type;

    $sample(context, property as never, { name: "fixture" });
    $sample(context, property as never, { other: "fixture" });

    assert.deepEqual(getStateValue(program, StateKeys.samples, property), [
      { sample: { name: "fixture" }, title: "", description: "" },
    ]);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, "typra-emitter-sample-name-mismatch");
  });

  it("records model marker decorators", () => {
    const { context, program } = createContext();
    const target = { kind: "Model", name: "Fixture" } as Type;

    $abstract(context, target as never);
    $protocol(context, target as never);

    assert.equal(getStateScalar(program, StateKeys.abstracts, target), true);
    assert.equal(getStateScalar(program, StateKeys.protocols, target), true);
  });

  it("records coercions and reports non-scalar coercion targets", () => {
    const { context, program, diagnostics } = createContext();
    const target = { kind: "Model", name: "FixtureReference" } as Type;

    $coerce(
      context,
      target as never,
      { kind: "Scalar", name: "string" } as Type,
      { id: "{value}", label: "coerced" },
      "reference",
      "Load from string",
      "ref-1",
    );
    $coerce(context, target as never, { kind: "Model", name: "NotScalar" } as Type, { id: "{value}" });

    assert.deepEqual(getStateValue(program, StateKeys.coercions, target), [
      {
        scalar: "string",
        expansion: { id: "{value}", label: "coerced" },
        example: "ref-1",
        title: "reference",
        description: "Load from string",
      },
    ]);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, "typra-emitter-coerce-scalar-type");
  });

  it("records factory and method metadata", () => {
    const { context, program } = createContext();
    const target = { kind: "Model", name: "FixtureReference" } as Type;

    $factory(context, target as never, "named", { id: "{id}" }, { id: "string" });
    $method(context, target as never, "display", "string", "Render label", { prefix: "string" }, true, true);

    assert.deepEqual(getStateValue(program, StateKeys.factories, target), [
      { name: "named", sets: { id: "{id}" }, params: { id: "string" } },
    ]);
    assert.deepEqual(getStateValue(program, StateKeys.methods, target), [
      {
        name: "display",
        returns: "string",
        description: "Render label",
        params: { prefix: "string" },
        optional: true,
        sync: true,
      },
    ]);
  });

  it("records provider wire mappings and provider defaults", () => {
    const { context, program } = createContext();
    const property = { kind: "ModelProperty", name: "maxOutputTokens" } as Type;

    $knownAs(context, property as never, "openai", "max_completion_tokens");
    $knownAs(context, property as never, "anthropic", "max_tokens");
    $defaultFor(context, property as never, "openai", 256);

    assert.deepEqual(getStateValue(program, StateKeys.knownAs, property), [
      { provider: "openai", name: "max_completion_tokens" },
      { provider: "anthropic", name: "max_tokens" },
    ]);
    assert.deepEqual(getStateValue(program, StateKeys.defaultFor, property), [
      { provider: "openai", defaultValue: 256 },
    ]);
  });

  it("records parse aliases for string unions and rejects conflicts", () => {
    const { context, program, diagnostics } = createContext();
    const readyVariant = { type: { kind: "String", value: "ready" } };
    const archivedVariant = { type: { kind: "String", value: "archived" } };
    const target = {
      kind: "Union",
      name: "FixtureStatus",
      variants: new Map([
        ["ready", readyVariant],
        ["archived", archivedVariant],
      ]),
    } as unknown as Type;

    $parseAlias(context, target as never, "ready", ["complete", "done"]);
    $parseAlias(context, target as never, "ready", ["complete"]);
    $parseAlias(context, target as never, "archived", ["done"]);

    assert.deepEqual(getStateValue(program, StateKeys.parseAliases, target), [
      { canonical: "ready", aliases: ["complete", "done"] },
    ]);
    assert.equal(diagnostics.length, 2);
    assert.equal(diagnostics[0].code, "typra-emitter-parse-alias-duplicate");
    assert.equal(diagnostics[1].code, "typra-emitter-parse-alias-conflict");
  });
});
