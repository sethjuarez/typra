// A string-literal enum used by models in more than one generated file must be declared
// once in targets whose files share a namespace (a Go package, a Swift module, Rust's
// glob re-exports from mod.rs); otherwise the generated code does not compile.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { hoistSharedEnums } from "../src/ir/lower.js";
import type { EnumDef, FileDecl } from "../src/ir/declarations.js";

const require = createRequire(import.meta.url);

const TARGETS: Array<[type: string, dir: string, native?: string]> = [
  ["Go", "go"],
  ["Rust", "rust"],
  ["Rust", "rust-serde", "serde"],
  ["Swift", "swift"],
  ["Swift", "swift-codable", "codable"],
];

const SPEC = `import "@typra/emitter";

namespace Typra.Fixtures.SharedEnums;

@serializable
model Root {
  first: First;
  second: Second;
}

@parseAlias("ready", #["done"])
union Status {
  draft: "draft";
  ready: "ready";
}

alias Tone = "calm" | "loud";

model First {
  status: Status;
  tone: Tone;
}

model Second {
  status?: Status;
  tone: Tone;
}
`;

function tspCli(): string {
  const compilerEntry = require.resolve("@typespec/compiler");
  const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
  return path.join(compilerRoot, "cmd", "tsp.js");
}

function compile(root: string): string {
  const source = path.join(root, "main.tsp");
  writeFileSync(source, SPEC);
  const config = path.join(root, "tspconfig.yaml");
  const lines = [
    "emit:",
    '  - "@typra/emitter"',
    "options:",
    '  "@typra/emitter":',
    `    emitter-output-dir: ${JSON.stringify(path.join(root, "generated"))}`,
    '    root-object: "Typra.Fixtures.SharedEnums.Root"',
    "    deterministic-output: true",
    "    emit-targets:",
  ];
  for (const [type, dir, native] of TARGETS) {
    lines.push(`      - type: ${type}`);
    lines.push(
      `        output-dir: ${JSON.stringify(path.join(root, "generated", dir))}`,
    );
    lines.push(
      `        test-dir: ${JSON.stringify(path.join(root, "generated", dir, "tests"))}`,
    );
    lines.push("        format: false");
    if (native) lines.push(`        native-serialization: ${native}`);
  }
  writeFileSync(config, [...lines, ""].join("\n"));
  const result = spawnSync(
    process.execPath,
    [tspCli(), "compile", source, "--config", config],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}

function readTree(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else
        files.set(
          path.relative(dir, full).split(path.sep).join("/"),
          readFileSync(full, "utf8"),
        );
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

describe("string-literal enums shared across generated files", () => {
  let root = "";
  let output = "";
  const generated = new Map<string, Map<string, string>>();

  before(() => {
    root = mkdtempSync(path.join(process.cwd(), "tmp-shared-enums-"));
    output = compile(root);
    for (const [, dir] of TARGETS) {
      generated.set(dir, readTree(path.join(root, "generated", dir)));
    }
  });

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  // Library sources only; generated tests live under tests/.
  const declaringFiles = (dir: string, declaration: RegExp) =>
    [...generated.get(dir)!.entries()]
      .filter(([name]) => !name.startsWith("tests/"))
      .filter(([, content]) => declaration.test(content))
      .map(([name]) => name);

  it("compiles without diagnostics", () => {
    assert.doesNotMatch(output, /error|warning/i, output);
  });

  const DECLARATIONS: Array<[dir: string, enumName: string, pattern: RegExp]> =
    [];
  for (const enumName of ["Status", "Tone"]) {
    DECLARATIONS.push(
      ["go", enumName, new RegExp(`^type ${enumName} string$`, "m")],
      ["rust", enumName, new RegExp(`^pub enum ${enumName} \\{`, "m")],
      ["rust-serde", enumName, new RegExp(`^pub enum ${enumName} \\{`, "m")],
      ["swift", enumName, new RegExp(`^public enum ${enumName}\\b`, "m")],
      [
        "swift-codable",
        enumName,
        new RegExp(`^public enum ${enumName}\\b`, "m"),
      ],
    );
  }

  for (const [dir, enumName, pattern] of DECLARATIONS) {
    it(`${dir} declares ${enumName} exactly once`, () => {
      assert.deepEqual(
        declaringFiles(dir, pattern).length,
        1,
        `${enumName} declared in: ${declaringFiles(dir, pattern).join(", ")}`,
      );
    });
  }

  for (const dir of ["rust", "rust-serde"]) {
    it(`${dir} imports the shared enums from the declaring module`, () => {
      const [owner] = declaringFiles(dir, /^pub enum Status \{/m);
      const ownerModule = path.posix.basename(owner, ".rs");
      const files = generated.get(dir)!;
      const user = [...files.entries()].find(
        ([name, content]) =>
          !name.startsWith("tests/") &&
          name !== owner &&
          name.endsWith(".rs") &&
          /\bstatus: Option<Status>/.test(content),
      );
      assert.ok(user, "no non-owner module uses Status");
      assert.match(
        user[1],
        new RegExp(`^use super::${ownerModule}::\\{Status, Tone\\};$`, "m"),
      );
    });
  }
});

describe("hoistSharedEnums", () => {
  const enumDef = (name: string, values: string[]): EnumDef => ({
    name,
    values,
    parseAliases: {},
    isOpen: false,
  });
  const file = (
    name: string,
    enums: EnumDef[],
    imports: FileDecl["imports"] = [],
  ): FileDecl => ({
    typeName: { name, namespace: "Typra.Test" },
    types: [],
    imports,
    containsAbstract: false,
    enums,
    group: "",
  });

  it("keeps a same-named enum whose definition differs", () => {
    const [first, second] = hoistSharedEnums([
      file("First", [enumDef("Level", ["low", "high"])]),
      file("Second", [enumDef("Level", ["a", "b"])]),
    ]);
    assert.deepEqual(
      first.enums.map((def) => def.values),
      [["low", "high"]],
    );
    assert.deepEqual(
      second.enums.map((def) => def.values),
      [["a", "b"]],
    );
    assert.deepEqual(second.imports, []);
  });

  it("merges a hoisted enum into an existing import of the owning module", () => {
    const [, second] = hoistSharedEnums([
      file("First", [enumDef("Level", ["low", "high"])]),
      file(
        "Second",
        [enumDef("Level", ["low", "high"])],
        [
          { module: "Alpha", names: ["Alpha"], group: "" },
          { module: "First", names: ["First"], group: "" },
        ],
      ),
    ]);
    assert.deepEqual(second.enums, []);
    assert.deepEqual(second.imports, [
      { module: "Alpha", names: ["Alpha"], group: "" },
      { module: "First", names: ["First", "Level"], group: "" },
    ]);
  });

  it("treats differing parse aliases as a different definition", () => {
    const aliased = {
      ...enumDef("Level", ["low", "high"]),
      parseAliases: { low: ["lo"] },
    };
    const [, second] = hoistSharedEnums([
      file("First", [enumDef("Level", ["low", "high"])]),
      file("Second", [aliased]),
    ]);
    assert.deepEqual(second.enums, [aliased]);
  });
});
