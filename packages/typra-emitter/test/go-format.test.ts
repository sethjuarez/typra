import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatGoSource } from "../src/languages/go/go-format.js";

/**
 * These lock the deterministic Go reflow (`formatGoSource`) against the exact output the host
 * formatter pipeline (`gofmt` + `goimports`) produces, so native (`format:false`) emission stays
 * byte-identical to formatted emission. Each golden mirrors `gofmt`'s layout (see #238): brace-depth
 * indentation, columnar (tabwriter) alignment, single-line composite tightening, blank-line
 * collapsing, and raw-string preservation.
 */
describe("formatGoSource", () => {
  it("indents a flush-left block by brace depth using tabs", () => {
    const input = "func f() {\nif x {\nreturn\n}\n}\n";
    const expected = "func f() {\n\tif x {\n\t\treturn\n\t}\n}\n";
    assert.equal(formatGoSource(input), expected);
  });

  it("dedents case/default labels one level inside a switch body", () => {
    const input = "switch v {\ncase 1:\nreturn\ndefault:\nreturn\n}\n";
    const expected = "switch v {\ncase 1:\n\treturn\ndefault:\n\treturn\n}\n";
    assert.equal(formatGoSource(input), expected);
  });

  it("indents a multi-line interface type in a case label relative to the label", () => {
    const input =
      "switch v := x.(type) {\ncase interface {\nSave() int\n}:\nreturn v.Save()\ndefault:\nreturn 0\n}\n";
    const expected =
      "switch v := x.(type) {\ncase interface {\n\tSave() int\n}:\n\treturn v.Save()\ndefault:\n\treturn 0\n}\n";
    assert.equal(formatGoSource(input), expected);
  });

  it("aligns struct field types into a column", () => {
    const input = "type T struct {\n\tName string\n\tID int\n}\n";
    const expected = "type T struct {\n\tName string\n\tID   int\n}\n";
    assert.equal(formatGoSource(input), expected);
  });

  it("aligns const spec values into a column", () => {
    const input = "const (\n\tA = 1\n\tBee = 2\n)\n";
    const expected = "const (\n\tA   = 1\n\tBee = 2\n)\n";
    assert.equal(formatGoSource(input), expected);
  });

  it("aligns keyed composite elements, including string keys", () => {
    const input = 'x := map[string]int{\n\t"a": 1,\n\t"bbb": 2,\n}\n';
    const expected = 'x := map[string]int{\n\t"a":   1,\n\t"bbb": 2,\n}\n';
    assert.equal(formatGoSource(input), expected);
  });

  it("tightens the interior of a single-line composite literal", () => {
    assert.equal(formatGoSource("x := T{ A: 1, B: 2 }\n"), "x := T{A: 1, B: 2}\n");
  });

  it("aligns the opening brace of adjacent one-line function declarations", () => {
    const input = "func Foo(t *T) { run(t, 0) }\nfunc Barbaz(t *T) { run(t, 1) }\n";
    const expected = "func Foo(t *T)    { run(t, 0) }\nfunc Barbaz(t *T) { run(t, 1) }\n";
    assert.equal(formatGoSource(input), expected);
  });

  it("collapses runs of blank lines to a single blank", () => {
    assert.equal(formatGoSource("package p\n\n\nimport \"x\"\n"), 'package p\n\nimport "x"\n');
  });

  it("preserves raw string interiors verbatim, including their blank lines", () => {
    const input = "func f() {\nx := `\na\n\nb\n`\n}\n";
    const expected = "func f() {\n\tx := `\na\n\nb\n`\n}\n";
    assert.equal(formatGoSource(input), expected);
  });

  it("does not treat brackets inside strings or comments as structural", () => {
    const input = 'func f() {\ns := "a{b}c" // note {\nreturn s\n}\n';
    const expected = 'func f() {\n\ts := "a{b}c" // note {\n\treturn s\n}\n';
    assert.equal(formatGoSource(input), expected);
  });

  it("is idempotent", () => {
    const input =
      "type T struct {\n\tName string\n\tID int\n}\n\nfunc f() {\nif x {\nreturn\n}\n}\n";
    const once = formatGoSource(input);
    assert.equal(formatGoSource(once), once);
  });
});
