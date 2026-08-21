import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatTypeScriptSource } from "../src/languages/typescript/typescript-format.js";

/**
 * These lock the deterministic TypeScript reflow (`formatTypeScriptSource`) against the exact output
 * the host formatter (`prettier`, default config) produces, so native (`format:false`) emission stays
 * byte-identical to formatted emission. Each golden was captured from `prettier` (see #238).
 */
describe("formatTypeScriptSource", () => {
  it("normalizes quotes to double unless that adds escapes", () => {
    assert.equal(formatTypeScriptSource("const a = 'hello';\n"), 'const a = "hello";\n');
    assert.equal(
      formatTypeScriptSource('const b = \'he said "hi"\';\n'),
      'const b = \'he said "hi"\';\n',
    );
  });

  it("drops quotes from object keys that are valid identifiers", () => {
    assert.equal(
      formatTypeScriptSource('const o = { "key": 1, "other": 2 };\n'),
      "const o = { key: 1, other: 2 };\n",
    );
  });

  it("adds parentheses around a single arrow parameter", () => {
    assert.equal(
      formatTypeScriptSource("const f = x => x + 1;\n"),
      "const f = (x) => x + 1;\n",
    );
  });

  it("explodes an over-long import into one specifier per line with a trailing comma", () => {
    const input =
      'import { alphaSymbol, betaSymbol, gammaSymbol, deltaSymbol, epsilonSymbol } from "./mod";\n';
    const expected =
      'import {\n  alphaSymbol,\n  betaSymbol,\n  gammaSymbol,\n  deltaSymbol,\n  epsilonSymbol,\n} from "./mod";\n';
    assert.equal(formatTypeScriptSource(input), expected);
  });

  it("demotes a conditional value to the next line instead of breaking its condition", () => {
    const input =
      'const provider = typeof vector.provider === "string" ? vector.provider : undefinedValueHere;\n';
    const expected =
      'const provider =\n  typeof vector.provider === "string" ? vector.provider : undefinedValueHere;\n';
    assert.equal(formatTypeScriptSource(input), expected);
  });

  it("explodes a function-type parameter list whose return type is atomic", () => {
    const input =
      "type VectorAdapter = {\n  invoke: (input: unknown, context: AdapterContext) => unknown | Promise<unknown>;\n};\n";
    const expected =
      "type VectorAdapter = {\n  invoke: (\n    input: unknown,\n    context: AdapterContext,\n  ) => unknown | Promise<unknown>;\n};\n";
    assert.equal(formatTypeScriptSource(input), expected);
  });

  it("demotes a for-loop's non-block body to the next line rather than breaking the assignment", () => {
    const input =
      "function f() {\n  for (const key of Object.keys(source).sort()) out[key] = canonical(source[key]);\n}\n";
    const expected =
      "function f() {\n  for (const key of Object.keys(source).sort())\n    out[key] = canonical(source[key]);\n}\n";
    assert.equal(formatTypeScriptSource(input), expected);
  });

  it("is idempotent: formatting already-formatted source is a no-op", () => {
    const formatted =
      'import {\n  alphaSymbol,\n  betaSymbol,\n  gammaSymbol,\n  deltaSymbol,\n  epsilonSymbol,\n} from "./mod";\n';
    assert.equal(formatTypeScriptSource(formatted), formatted);
  });
});
