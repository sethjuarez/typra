import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatPythonSource } from "../src/languages/python/python-format.js";

/**
 * These lock the deterministic Python reflow (`formatPythonSource`) against the exact output the
 * host formatter (`ruff format`, Black style) produces, so native (`format:false`) emission stays
 * byte-identical to formatted emission. Each golden was captured from `ruff format` (see #238).
 */
describe("formatPythonSource", () => {
  it("wraps an over-long assert in optional parens and breaks at the comparison operator", () => {
    const input =
      'def f():\n    assert instance.value == "first line with two spaces  \\n\\n  \\nlast line with three spaces   \\n"\n';
    const expected =
      'def f():\n    assert (\n        instance.value\n        == "first line with two spaces  \\n\\n  \\nlast line with three spaces   \\n"\n    )\n';
    assert.equal(formatPythonSource(input), expected);
  });

  it("keeps a comparison on one line when the optional-paren body fits at the deeper indent", () => {
    const input =
      "def f():\n    x = FixtureAbstractTextContent.model_validate_json(json_data).save() == saved_data\n";
    // 86 columns after re-indent — Black leaves it unsplit.
    assert.equal(formatPythonSource(input), input);
  });

  it("breaks a long boolean test at its top-level and/or operators", () => {
    const input =
      "def f():\n    if alpha_flag and beta_flag and gamma_flag and delta_flag and epsilon_flag and zeta_flag:\n        pass\n";
    const expected =
      "def f():\n    if (\n        alpha_flag\n        and beta_flag\n        and gamma_flag\n        and delta_flag\n        and epsilon_flag\n        and zeta_flag\n    ):\n        pass\n";
    assert.equal(formatPythonSource(input), expected);
  });

  it("splits an over-long comprehension at its for/if clauses, not its commas", () => {
    const input =
      "def f():\n    result = [transform(item) for item in collection if item.is_valid and item.value > threshold_x]\n";
    const expected =
      "def f():\n    result = [\n        transform(item)\n        for item in collection\n        if item.is_valid and item.value > threshold_x\n    ]\n";
    assert.equal(formatPythonSource(input), expected);
  });

  it("explodes an over-long collection literal one element per line with a trailing comma", () => {
    const input =
      'def f():\n    payload = {"alpha": 1, "beta": 2, "gamma": 3, "delta": 4, "epsilon": 5, "zeta": 6, "eta": 7}\n';
    const expected =
      'def f():\n    payload = {\n        "alpha": 1,\n        "beta": 2,\n        "gamma": 3,\n        "delta": 4,\n        "epsilon": 5,\n        "zeta": 6,\n        "eta": 7,\n    }\n';
    assert.equal(formatPythonSource(input), expected);
  });

  it("wraps a long from-import into a parenthesized one-name-per-line list", () => {
    const input =
      "from some.deeply.nested.module.path import alpha_symbol, beta_symbol, gamma_symbol, delta_symbol\n";
    const expected =
      "from some.deeply.nested.module.path import (\n    alpha_symbol,\n    beta_symbol,\n    gamma_symbol,\n    delta_symbol,\n)\n";
    assert.equal(formatPythonSource(input), expected);
  });

  it("normalizes quotes to double unless that adds escapes", () => {
    const input = "x = 'single'\ny = \"already\"\nz = 'he said \"hi\"'\nw = \"it\\'s fine\"\n";
    const expected = "x = \"single\"\ny = \"already\"\nz = 'he said \"hi\"'\nw = \"it's fine\"\n";
    assert.equal(formatPythonSource(input), expected);
  });

  it("normalizes blank lines around top-level and nested defs", () => {
    const input =
      "import os\ndef a():\n    pass\ndef b():\n    pass\nclass C:\n    def m(self):\n        pass\n    def n(self):\n        pass\n";
    const expected =
      "import os\n\n\ndef a():\n    pass\n\n\ndef b():\n    pass\n\n\nclass C:\n    def m(self):\n        pass\n\n    def n(self):\n        pass\n";
    assert.equal(formatPythonSource(input), expected);
  });

  it("is idempotent: formatting already-formatted source is a no-op", () => {
    const formatted =
      "def f():\n    if (\n        alpha_flag\n        and beta_flag\n        and gamma_flag\n        and delta_flag\n        and epsilon_flag\n        and zeta_flag\n    ):\n        pass\n";
    assert.equal(formatPythonSource(formatted), formatted);
  });

  it("leaves apostrophes inside triple-quoted docstrings untouched", () => {
    const input = 'def f():\n    """Typra\'s docstring with an apostrophe."""\n    return 1\n';
    assert.equal(formatPythonSource(input), input);
  });

  it("wraps only the final right-hand side of a chained assignment", () => {
    const input =
      'def f():\n    first_target = second_target = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"\n';
    const expected =
      'def f():\n    first_target = second_target = (\n        "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"\n    )\n';
    assert.equal(formatPythonSource(input), expected);
  });

  it("never wraps `assert cond, message` into a semantics-changing tuple", () => {
    // Wrapping the whole statement would assert a truthy tuple; leave it unchanged instead.
    const input =
      'def f():\n    assert condition_condition_condition_condition_condition_condition_condition_ok, "boom failed"\n';
    assert.equal(formatPythonSource(input), input);
  });
});
