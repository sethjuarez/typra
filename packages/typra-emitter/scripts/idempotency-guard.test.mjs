import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { TOOLCHAIN_UNAVAILABLE } from "./validation-execution.mjs";
import {
  IDEMPOTENCY_DEFERRED,
  IDEMPOTENCY_TARGETS,
  assertLockedTargetsMeasurable,
  computeTreeDiff,
  decideIdempotencyOutcome,
  idempotencyAllowedSkips,
} from "./idempotency-guard.mjs";

function walkFiles(dir, predicate = () => true) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full, predicate));
    else if (predicate(full)) files.push(full);
  }
  return files;
}

const tempDirs = [];
function makeTree(files) {
  const root = mkdtempSync(path.join(tmpdir(), "typra-idem-test-"));
  tempDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("idempotency-guard: decideIdempotencyOutcome", () => {
  it("passes a locked target whose formatter is a zero-diff no-op", () => {
    const outcome = decideIdempotencyOutcome({
      status: "locked",
      toolAvailable: true,
      drift: { total: 10, changed: 0, changedFiles: [] },
    });
    assert.deepEqual(outcome, { action: "pass" });
  });

  it("fails a locked target the formatter rewrites (the reproducibility hole)", () => {
    const drift = { total: 10, changed: 3, changedFiles: ["a", "b", "c"] };
    const outcome = decideIdempotencyOutcome({
      status: "locked",
      toolAvailable: true,
      drift,
    });
    assert.equal(outcome.action, "fail");
    assert.equal(outcome.drift, drift);
  });

  it("skips a locked target as toolchain-unavailable when the formatter is absent", () => {
    const outcome = decideIdempotencyOutcome({
      status: "locked",
      toolAvailable: false,
      drift: null,
    });
    assert.deepEqual(outcome, {
      action: "skip",
      reason: TOOLCHAIN_UNAVAILABLE,
    });
  });

  it("throws if a locked target is decided without a measured drift", () => {
    assert.throws(
      () =>
        decideIdempotencyOutcome({
          status: "locked",
          toolAvailable: true,
          drift: null,
        }),
      /must be measured/,
    );
  });

  it("records a deferred target as a documented skipped-lock regardless of tool/drift", () => {
    for (const toolAvailable of [true, false]) {
      for (const drift of [null, { total: 5, changed: 5, changedFiles: [] }]) {
        const outcome = decideIdempotencyOutcome({
          status: "deferred",
          toolAvailable,
          drift,
        });
        assert.deepEqual(outcome, {
          action: "skip",
          reason: IDEMPOTENCY_DEFERRED,
        });
      }
    }
  });

  it("rejects an unknown status so new targets must declare locked or deferred", () => {
    assert.throws(
      () =>
        decideIdempotencyOutcome({
          status: "maybe",
          toolAvailable: true,
          drift: null,
        }),
      /Unknown idempotency status/,
    );
  });
});

describe("idempotency-guard: computeTreeDiff", () => {
  const diff = (sourceDir, formattedDir) =>
    computeTreeDiff({
      sourceDir,
      formattedDir,
      extension: ".txt",
      walkFiles,
      readFileSync,
      existsSync,
    });

  it("reports zero drift when the formatted copy is byte-identical", () => {
    const source = makeTree({ "a.txt": "x\n", "nested/b.txt": "y\n" });
    const copy = mkdtempSync(path.join(tmpdir(), "typra-idem-test-copy-"));
    tempDirs.push(copy);
    cpSync(source, copy, { recursive: true });
    const result = diff(source, copy);
    assert.deepEqual(result, { total: 2, changed: 0, changedFiles: [] });
  });

  it("counts a file the formatter rewrote", () => {
    const source = makeTree({ "a.txt": "x\n", "b.txt": "y\n" });
    const copy = mkdtempSync(path.join(tmpdir(), "typra-idem-test-copy-"));
    tempDirs.push(copy);
    cpSync(source, copy, { recursive: true });
    writeFileSync(path.join(copy, "a.txt"), "x reformatted\n");
    const result = diff(source, copy);
    assert.equal(result.changed, 1);
    assert.deepEqual(result.changedFiles, ["a.txt"]);
  });

  it("counts a file the formatter dropped as changed", () => {
    const source = makeTree({ "a.txt": "x\n", "b.txt": "y\n" });
    const copy = mkdtempSync(path.join(tmpdir(), "typra-idem-test-copy-"));
    tempDirs.push(copy);
    writeFileSync(path.join(copy, "a.txt"), "x\n");
    const result = diff(source, copy);
    assert.equal(result.changed, 1);
    assert.deepEqual(result.changedFiles, ["b.txt"]);
  });

  it("ignores files outside the checked extension", () => {
    const source = makeTree({ "a.txt": "x\n", "a.md": "keep\n" });
    const copy = mkdtempSync(path.join(tmpdir(), "typra-idem-test-copy-"));
    tempDirs.push(copy);
    cpSync(source, copy, { recursive: true });
    writeFileSync(path.join(copy, "a.md"), "changed but not checked\n");
    const result = diff(source, copy);
    assert.deepEqual(result, { total: 1, changed: 0, changedFiles: [] });
  });

  it("counts a file the formatter created (added), not just rewrites/deletions", () => {
    const source = makeTree({ "a.txt": "x\n" });
    const copy = mkdtempSync(path.join(tmpdir(), "typra-idem-test-copy-"));
    tempDirs.push(copy);
    cpSync(source, copy, { recursive: true });
    writeFileSync(path.join(copy, "b.txt"), "new file\n");
    const result = diff(source, copy);
    assert.equal(result.total, 2);
    assert.equal(result.changed, 1);
    assert.deepEqual(result.changedFiles, ["b.txt"]);
  });

  it("skips ignored scratch segments on both sides (no false deletion)", () => {
    const source = makeTree({
      "main.txt": "x\n",
      "target/build.txt": "artifact\n",
    });
    // The copy excluded the scratch dir (as measureFormatterDrift does), so target/ is absent.
    const copy = mkdtempSync(path.join(tmpdir(), "typra-idem-test-copy-"));
    tempDirs.push(copy);
    writeFileSync(path.join(copy, "main.txt"), "x\n");
    const result = computeTreeDiff({
      sourceDir: source,
      formattedDir: copy,
      extension: ".txt",
      walkFiles,
      readFileSync,
      existsSync,
      ignoreSegments: new Set(["target"]),
    });
    assert.deepEqual(result, { total: 1, changed: 0, changedFiles: [] });
  });
});

describe("idempotency-guard: target registry", () => {
  it("declares unique, well-formed targets", () => {
    const stageIds = new Set();
    for (const target of IDEMPOTENCY_TARGETS) {
      assert.ok(target.id, "target must have an id");
      assert.equal(
        target.stageId,
        `idempotency.${target.id}`,
        "stageId must be idempotency.<id>",
      );
      assert.ok(target.dir, `${target.id} must have a dir`);
      assert.match(target.extension, /^\./, `${target.id} extension`);
      assert.ok(target.tool, `${target.id} must name its formatter`);
      assert.ok(
        target.status === "locked" || target.status === "deferred",
        `${target.id} status must be locked or deferred`,
      );
      if (target.status === "deferred") {
        assert.ok(target.reason, `${target.id} deferral must be documented`);
      }
      assert.ok(!stageIds.has(target.stageId), `duplicate ${target.stageId}`);
      stageIds.add(target.stageId);
    }
  });

  it("defers Go (it ships format:true; native output is not gofmt-idempotent)", () => {
    const go = IDEMPOTENCY_TARGETS.find((target) => target.id === "go");
    assert.ok(go, "go idempotency target must exist");
    assert.equal(go.status, "deferred");
    assert.equal(go.tool, "gofmt");
    assert.ok(go.reason, "go deferral must be documented");
  });

  it("locks nothing yet — the native-output audit found every runtime drifts", () => {
    const locked = IDEMPOTENCY_TARGETS.filter(
      (target) => target.status === "locked",
    );
    assert.deepEqual(
      locked,
      [],
      `no runtime is formatter-idempotent yet; unexpectedly locked: ${locked
        .map((t) => t.id)
        .join(", ")}`,
    );
  });

  it("rejects a locked target that is not measurable", () => {
    assert.throws(
      () =>
        assertLockedTargetsMeasurable([
          { id: "phantom", status: "locked", measurable: false },
        ]),
      /locked but measurable:false/,
      "a locked + measurable:false target would abort the run with an uncaught throw, so the registry invariant must reject it",
    );
  });

  it("accepts the shipped registry (locked targets, if any, are measurable)", () => {
    assert.doesNotThrow(() => assertLockedTargetsMeasurable());
  });

  it("covers every native (format:false) code runtime", () => {
    const ids = new Set(IDEMPOTENCY_TARGETS.map((target) => target.id));
    for (const id of [
      "typescript",
      "typescript-zod",
      "python",
      "python_pydantic",
      "rust",
      "rust-serde",
      "swift",
      "swift-codable",
      "csharp",
      "java",
      "java-jackson",
    ]) {
      assert.ok(ids.has(id), `missing idempotency target for ${id}`);
    }
  });

  it("maps each stage to its allowed skip reason", () => {
    const allowed = idempotencyAllowedSkips();
    for (const target of IDEMPOTENCY_TARGETS) {
      assert.equal(
        allowed[target.stageId],
        target.status === "locked"
          ? TOOLCHAIN_UNAVAILABLE
          : IDEMPOTENCY_DEFERRED,
      );
    }
  });
});
