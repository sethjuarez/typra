// Durable "gate bites" proof for the web-conditions ESM loader. Materializes a
// tiny dual-export package (a `node` branch that mimics a Node-only dependency
// and a `browser`/`default` branch that works on the web) plus a small
// "generated" module graph, then asserts the loader:
//   1. forces browser dependency resolution (picks the browser branch where
//      plain Node picks the node branch),
//   2. rejects Node builtins imported from generated code,
//   3. re-adds the extension tsc omits from relative specifiers.
// It exercises the loader through a real `node --import` subprocess, the same
// way the web-runtime smoke stage does, and never touches the fixture harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const registerUrl = pathToFileURL(
  path.join(here, "fixtures", "web-conditions-register.mjs"),
).href;

function scaffold() {
  const root = mkdtempSync(path.join(tmpdir(), "typra-web-loader-"));
  const gen = path.join(root, "gen");
  const dual = path.join(root, "node_modules", "dual");
  mkdirSync(gen, { recursive: true });
  mkdirSync(dual, { recursive: true });

  writeFileSync(
    path.join(dual, "package.json"),
    JSON.stringify({
      name: "dual",
      type: "module",
      exports: { node: "./node.js", browser: "./browser.js", default: "./browser.js" },
    }),
  );
  // Mimics a Node-only dependency: importing it eagerly reaches for a builtin.
  writeFileSync(
    path.join(dual, "node.js"),
    'import "node:fs";\nexport const flavor = "node";\n',
  );
  writeFileSync(path.join(dual, "browser.js"), 'export const flavor = "browser";\n');

  return { root, gen };
}

function runNode(entry, { withLoader, generatedDirUrl }) {
  const args = withLoader ? ["--import", registerUrl, entry] : [entry];
  return execFileSync(process.execPath, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      ...(generatedDirUrl ? { TYPRA_WEB_GENERATED_URL: generatedDirUrl } : {}),
    },
  });
}

test("loader forces browser resolution where plain Node picks the node branch", () => {
  const { root, gen } = scaffold();
  try {
    const entry = path.join(gen, "entry.mjs");
    writeFileSync(
      entry,
      'import { flavor } from "dual";\nprocess.stdout.write(flavor);\n',
    );
    const generatedDirUrl = pathToFileURL(gen + path.sep).href;

    // Plain Node applies the `node` condition -> node branch (works on Node).
    assert.equal(runNode(entry, { withLoader: false }), "node");

    // Under the loader the browser branch is selected instead.
    const out = runNode(entry, { withLoader: true, generatedDirUrl });
    assert.equal(out, "browser");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loader rejects Node builtins imported from generated code", () => {
  const { root, gen } = scaffold();
  try {
    const entry = path.join(gen, "bad.mjs");
    writeFileSync(entry, 'import "node:fs";\nprocess.stdout.write("unreachable");\n');
    const generatedDirUrl = pathToFileURL(gen + path.sep).href;

    let message = "";
    try {
      runNode(entry, { withLoader: true, generatedDirUrl });
      assert.fail("expected the loader to reject a Node builtin");
    } catch (error) {
      message = String(error.stderr ?? error.message ?? "");
    }
    assert.match(message, /Node builtin "node:fs"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loader re-adds the extension tsc omits from relative imports", () => {
  const { root, gen } = scaffold();
  try {
    writeFileSync(path.join(gen, "helper.js"), 'export const value = "helped";\n');
    const entry = path.join(gen, "entry-rel.mjs");
    // Extensionless relative specifier, as tsc emits under module ESNext.
    writeFileSync(
      entry,
      'import { value } from "./helper";\nprocess.stdout.write(value);\n',
    );
    const generatedDirUrl = pathToFileURL(gen + path.sep).href;

    // Native ESM without the loader cannot resolve the extensionless specifier.
    assert.throws(() => runNode(entry, { withLoader: false }));

    const out = runNode(entry, { withLoader: true, generatedDirUrl });
    assert.equal(out, "helped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
