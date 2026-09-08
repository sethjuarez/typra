import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkTestCategoryParity } from "./test-category-parity-policy.mjs";

// The canonical backend set (mirrors REQUIRED_CONFORMANCE_MATRIX_TARGETS).
const CANONICAL = ["typescript", "python", "csharp", "go", "java", "rust", "swift"];

// A minimal, self-consistent matrix: one file per backend, one `wire` category
// whose markers are always present in a fake in-memory corpus. This lets us
// prove the policy is non-vacuous without touching the real generated fixtures.
function makeFixture() {
  const files = Object.fromEntries(CANONICAL.map((b) => [b, `${b}.test`]));
  const wire = Object.fromEntries(
    CANONICAL.map((b) => [b, [`toWire:${b}`, `fromWire:${b}`]]),
  );
  // corpus: every backend's file contains both of its own markers
  const corpus = Object.fromEntries(
    CANONICAL.map((b) => [`${b}.test`, `toWire:${b}\nfromWire:${b}\n`]),
  );
  const readFile = (rel) => (rel in corpus ? corpus[rel] : null);
  return { files, wire, corpus, readFile };
}

function run(files, categories, readFile) {
  return checkTestCategoryParity({
    wireOptionsTestFiles: files,
    testCategoryParity: categories,
    canonicalBackends: CANONICAL,
    readFile,
  });
}

describe("test-category parity policy", () => {
  it("passes on a complete, self-consistent matrix", () => {
    const { files, wire, readFile } = makeFixture();
    assert.deepEqual(run(files, { wire }, readFile), []);
  });

  it("fails when a fixture drops a required marker (the #328 failure mode)", () => {
    const { files, wire, corpus } = makeFixture();
    // rust's file loses its fromWire emission, but the matrix still requires it.
    corpus["rust.test"] = "toWire:rust\n";
    const readFile = (rel) => (rel in corpus ? corpus[rel] : null);
    const failures = run(files, { wire }, readFile);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /rust.*fromWire:rust/);
  });

  it("fails when a canonical backend has no test file entry", () => {
    const { files, wire, readFile } = makeFixture();
    delete files.swift;
    const failures = run(files, { wire }, readFile);
    assert.ok(failures.some((f) => /canonical backend "swift" has no/.test(f)));
  });

  it("fails when a backend's category has an empty marker list", () => {
    const { files, wire, readFile } = makeFixture();
    const broken = { wire: { ...wire, go: [] } };
    const failures = run(files, broken, readFile);
    assert.ok(failures.some((f) => /go.*empty marker list/.test(f)));
  });

  it("fails when a backend has no entry at all for a category", () => {
    const { files, wire, readFile } = makeFixture();
    const missing = { wire: { ...wire } };
    delete missing.wire.python;
    const failures = run(files, missing, readFile);
    assert.ok(failures.some((f) => /python.*no entry/.test(f)));
  });

  it("fails when a category references an unknown/stale backend", () => {
    const { files, wire, readFile } = makeFixture();
    const stale = { wire: { ...wire, kotlin: ["x"] } };
    const failures = run(files, stale, readFile);
    assert.ok(failures.some((f) => /unknown backend "kotlin"/.test(f)));
  });

  it("rejects a bare waiver but accepts one carrying a reason", () => {
    const { files, wire, readFile } = makeFixture();

    const bare = { wire: { ...wire, go: {} } };
    assert.ok(
      run(files, bare, readFile).some((f) => /go.*must be an array/.test(f)),
      "a reasonless waiver object must fail",
    );

    const reasoned = { wire: { ...wire, go: { waived: "n/a for this type" } } };
    assert.deepEqual(
      run(files, reasoned, readFile),
      [],
      "a waiver with a non-empty reason must pass",
    );
  });
});
