import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { generate } from "../src/generate.js";

// Regression: a Go void seam method returns only `error`, so the typed @dispatch
// conformance must assign `err = impl.M(...)` for both the expectedError arm and
// the success arm. `_, err =` / `actual, err :=` does not compile against
// `M(...) error`.

const SPEC = `import "@typra/emitter";
namespace Typra.Fixtures.Test.GoVoidDispatch;

@doc("Sink dialects.")
union SinkKind { file: "file", memory: "memory" }

@doc("Polymorphic sink config.")
@discriminator("kind")
model SinkConfig { kind: SinkKind; }

@doc("File sink.")
model FileSink extends SinkConfig { kind: "file"; @doc("Path.") path: string; }

@doc("Memory sink.")
model MemorySink extends SinkConfig { kind: "memory"; }

@doc("Sink seam resolved by dialect.")
@dispatch(SinkConfig.kind)
interface Sink {
  @vector(#{
    name: "file-write-ok",
    stage: "callable",
    input: #{ config: #{ kind: "file", path: "out.txt" } },
    expected: null,
  })
  @vector(#{
    name: "file-write-empty-path",
    stage: "callable",
    input: #{ config: #{ kind: "file", path: "" } },
    expectedError: "empty path",
  })
  @doc("Write to the sink.")
  write(config: SinkConfig): void;
}

@serializable
@doc("Fixture root.")
model Root { @doc("Config.") config: SinkConfig; }
`;

describe("Go typed @dispatch conformance handles void seam methods", () => {
  let specDir: string;
  let output: string;
  let result: Awaited<ReturnType<typeof generate>>;

  before(async () => {
    specDir = mkdtempSync(path.join(process.cwd(), ".tmp-go-void-dispatch-"));
    output = mkdtempSync(path.join(process.cwd(), ".tmp-go-void-dispatch-out-"));
    writeFileSync(path.join(specDir, "main.tsp"), SPEC, "utf8");
    result = await generate({
      output,
      source: path.join(specDir, "main.tsp"),
      rootObject: "Typra.Fixtures.Test.GoVoidDispatch.Root",
      targets: ["go"],
      format: false,
      generateTests: true,
      deterministic: true,
    });
  });

  after(() => {
    for (const dir of [specDir, output]) {
      if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits Go successfully", () => {
    assert.equal(result.success, true, result.errors?.join("\n"));
  });

  it("the seam method returns only error", () => {
    const iface = readFileSync(path.join(output, "go", "sink.go"), "utf8");
    assert.match(iface, /Write\(config SinkConfig\) error\n/, iface);
  });

  it("uses `err =` for void calls in both arms", () => {
    const src = readFileSync(
      path.join(output, "go", "tests", "sink_conformance_test.go"),
      "utf8",
    );
    assert.match(src, /\terr = impl\.Write\(config\)\n\tif err == nil \{/, src);
    assert.match(src, /\tif err = impl\.Write\(config\); err != nil \{/, src);
    assert.doesNotMatch(src, /_, err = impl\.Write/);
    assert.doesNotMatch(src, /actual, err := impl\.Write/);
  });
});
