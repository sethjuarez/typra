// Copyright (c) Microsoft. All rights reserved.

// Executable proof that the Part III typed @dispatch resolver (issue #282) is an
// ENFORCED contract on the Go target. Go cannot check interface-set completeness
// at compile time (a struct's zero value is an untyped nil, indistinguishable
// from a forgotten field), so the resolver's completeness guard is RUNTIME: the
// emitted `NewRendererProvider` collection constructor errors when a consumer
// omits a @dispatch variant key, and `ResolveRenderer` is the behavioral twin of
// the shape discriminator load switch. We compile the committed
// `fixtures/dispatch-seam` spec for Go, then exercise the EMITTED provider +
// resolver (`renderer_resolver.go`, a real library file in `package fixtures`)
// against consumer-authored renderers:
//
//   * positive -> a provider built from every @dispatch slot (liquid explicitly
//                 nil, a valid-but-unimplemented variant) routes each committed
//                 vector's discriminator through ResolveRenderer to the typed
//                 Renderer impl that reproduces `expected`                => PASS
//   * negative -> NewRendererProvider called with a map that DROPS one slot
//                 (mustache) returns a collection error naming the missing
//                 variant — the forgotten attachment can never silently skip,
//                 it fails loudly at construction                          => PASS
//                 (the guard's error is what the test asserts)
//
// A green positive and a negative that asserts the collection error together
// prove §5 control 2 for a runtime-enforced target: a missing provider slot
// errors at collection, never a silent miss. The typed render also exercises §5
// control 1 (correct route reproduces `expected`) through idiomatic, statically
// typed Go call sites rather than a JSON interpreter.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

const FIXTURE = path.resolve(
  process.cwd(),
  "fixtures",
  "dispatch-seam",
  "main.tsp",
);
const ROOT_OBJECT = "Typra.Fixtures.DispatchSeam.Root";
const MODULE = "typradispatchproof";

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function goAvailable(): boolean {
  try {
    execFileSync("go", ["version"], { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

type RunResult = { status: number; output: string };

function runGoTest(moduleDir: string): RunResult {
  try {
    const output = execFileSync("go", ["test", "-v", "-count=1", "./proof/"], {
      cwd: moduleDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GOFLAGS: "-mod=mod" },
    });
    return { status: 0, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: err.status ?? 1,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

// A local stub of `gopkg.in/yaml.v3`, wired in via a go.mod replace directive so
// the proof stays fully offline. The emitted models import yaml.v3 for their
// YAML round-trip helpers, but this proof only drives the JSON path, so the stub
// merely has to satisfy the compiler for the symbols the models reference.
const YAML_STUB = [
  "package yaml",
  "",
  "type Kind uint32",
  "",
  "const (",
  "\tScalarNode Kind = 1",
  "\tMappingNode Kind = 2",
  "\tSequenceNode Kind = 3",
  ")",
  "",
  "type Style uint32",
  "",
  "const DoubleQuotedStyle Style = 1",
  "",
  "type Node struct {",
  "\tKind    Kind",
  "\tTag     string",
  "\tValue   string",
  "\tContent []*Node",
  "\tStyle   Style",
  "}",
  "",
  "func (n *Node) Encode(v interface{}) error { return nil }",
  "",
  "func (n *Node) Decode(v interface{}) error { return nil }",
  "",
  "func Marshal(in interface{}) ([]byte, error) { return []byte{}, nil }",
  "",
  "func Unmarshal(in []byte, out interface{}) error { return nil }",
  "",
].join("\n");

// The consumer-authored, NON-emitted renderers that satisfy the emitted Renderer
// seam. Each understands only its own dialect's delimiter style (mustache
// `{{name}}`, jinja2 `{{ name }}`), read off the TYPED Agent/Inputs the emitted
// models produce — so a wrong slot would leave the template unsubstituted.
function proofTest(
  vectors: {
    name: string;
    agent: string;
    inputs: string;
    kind: string;
    expected: string;
  }[],
): string {
  const rows = vectors
    .map(
      (v) =>
        `\t{name: ${JSON.stringify(v.name)}, agent: ${JSON.stringify(
          v.agent,
        )}, inputs: ${JSON.stringify(v.inputs)}, kind: ${JSON.stringify(
          v.kind,
        )}, expected: ${JSON.stringify(v.expected)}},`,
    )
    .join("\n");
  return [
    "package proof",
    "",
    "import (",
    '\t"fmt"',
    '\t"strings"',
    '\t"testing"',
    "",
    `\tfixtures "${MODULE}/fixtures"`,
    ")",
    "",
    "// substitute is the consumer's dialect-specific rendering: it replaces",
    "// `open+key+close` tokens with the matching input value.",
    "func substitute(content string, values map[string]interface{}, open, close string) string {",
    "\tout := content",
    "\tfor key, value := range values {",
    "\t\ttoken := open + key + close",
    "\t\tout = strings.ReplaceAll(out, token, fmt.Sprint(value))",
    "\t}",
    "\treturn out",
    "}",
    "",
    "type mustacheRenderer struct{}",
    "",
    "func (mustacheRenderer) Render(agent fixtures.Agent, inputs fixtures.Inputs) (string, error) {",
    '\treturn substitute(agent.Template.Content, inputs.Values, "{{", "}}"), nil',
    "}",
    "",
    "type jinja2Renderer struct{}",
    "",
    "func (jinja2Renderer) Render(agent fixtures.Agent, inputs fixtures.Inputs) (string, error) {",
    '\treturn substitute(agent.Template.Content, inputs.Values, "{{ ", " }}"), nil',
    "}",
    "",
    "type vectorCase struct {",
    "\tname     string",
    "\tagent    string",
    "\tinputs   string",
    "\tkind     string",
    "\texpected string",
    "}",
    "",
    "var vectors = []vectorCase{",
    rows,
    "}",
    "",
    "// fullImpls attaches every @dispatch variant; liquid is present with a nil",
    "// value, a valid-but-unimplemented variant the resolver returns as (nil, nil)",
    "// for the caller to skip explicitly.",
    "func fullImpls() map[string]fixtures.Renderer {",
    "\treturn map[string]fixtures.Renderer{",
    '\t\t"mustache": mustacheRenderer{},',
    '\t\t"jinja2":   jinja2Renderer{},',
    '\t\t"liquid":   nil,',
    "\t}",
    "}",
    "",
    "// Positive: a complete provider routes every committed vector through the",
    "// typed resolver to the impl that reproduces `expected`.",
    "func TestTypedResolverRoutesEveryVector(t *testing.T) {",
    "\tprovider, err := fixtures.NewRendererProvider(fullImpls())",
    "\tif err != nil {",
    '\t\tt.Fatalf("complete provider should build: %v", err)',
    "\t}",
    "\tfor _, vc := range vectors {",
    "\t\tagent, err := fixtures.AgentFromJSON(vc.agent)",
    "\t\tif err != nil {",
    '\t\t\tt.Fatalf("%s: agent parse: %v", vc.name, err)',
    "\t\t}",
    "\t\tinputs, err := fixtures.InputsFromJSON(vc.inputs)",
    "\t\tif err != nil {",
    '\t\t\tt.Fatalf("%s: inputs parse: %v", vc.name, err)',
    "\t\t}",
    "\t\trenderer, err := fixtures.ResolveRenderer(vc.kind, provider)",
    "\t\tif err != nil {",
    '\t\t\tt.Fatalf("%s: resolve %q: %v", vc.name, vc.kind, err)',
    "\t\t}",
    "\t\tif renderer == nil {",
    '\t\t\tt.Fatalf("%s: no impl attached for %q", vc.name, vc.kind)',
    "\t\t}",
    "\t\tgot, err := renderer.Render(agent, inputs)",
    "\t\tif err != nil {",
    '\t\t\tt.Fatalf("%s: render: %v", vc.name, err)',
    "\t\t}",
    "\t\tif got != vc.expected {",
    '\t\t\tt.Fatalf("%s misrouted: got %q want %q", vc.name, got, vc.expected)',
    "\t\t}",
    "\t}",
    "}",
    "",
    "// Negative (RUNTIME control): a provider map that omits the mustache slot must",
    "// fail at collection with an error naming the missing variant. The forgotten",
    "// attachment can never silently skip.",
    "func TestMissingAttachmentIsCollectionError(t *testing.T) {",
    "\t_, err := fixtures.NewRendererProvider(map[string]fixtures.Renderer{",
    '\t\t"jinja2": jinja2Renderer{},',
    '\t\t"liquid": nil,',
    "\t})",
    "\tif err == nil {",
    '\t\tt.Fatal("provider missing the mustache slot must error at collection")',
    "\t}",
    '\tif !strings.Contains(err.Error(), "mustache") {',
    '\t\tt.Fatalf("collection error must name the missing variant: %v", err)',
    "\t}",
    "}",
    "",
    "// Unknown discriminator control: a closed dispatch resolves an unknown kind to",
    "// a hard error, the twin of the shape load switch's default arm.",
    "func TestUnknownDiscriminatorErrors(t *testing.T) {",
    "\tprovider, err := fixtures.NewRendererProvider(fullImpls())",
    "\tif err != nil {",
    '\t\tt.Fatalf("complete provider should build: %v", err)',
    "\t}",
    '\tif _, err := fixtures.ResolveRenderer("handlebars", provider); err == nil {',
    '\t\tt.Fatal("unknown discriminator must be a hard error")',
    "\t}",
    "}",
    "",
  ].join("\n");
}

describe("typed @dispatch resolver is a runtime-enforced contract (Go)", () => {
  it("routes typed vectors green; a missing provider slot errors at collection", (t) => {
    if (!goAvailable()) {
      t.skip("go toolchain not available");
      return;
    }

    const output = mkdtempSync(
      path.join(process.cwd(), "tmp-dispatch-typed-go-"),
    );
    const config = path.join(output, "tspconfig.yaml");
    const emitRoot = path.join(output, "generated");
    const goOut = path.join(emitRoot, "go");
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");
    try {
      // Compile the committed fixture spec for Go only. The emitter's tsp-compile
      // path emits the full model set the typed resolver call sites need.
      writeFileSync(
        config,
        [
          "emit:",
          '  - "@typra/emitter"',
          "options:",
          '  "@typra/emitter":',
          `    emitter-output-dir: ${yamlString(emitRoot)}`,
          `    root-object: ${yamlString(ROOT_OBJECT)}`,
          "    deterministic-output: true",
          "    emit-targets:",
          "      - type: Go",
          `        output-dir: ${yamlString(goOut)}`,
          '        import-path: "typradispatchproof/fixtures"',
          "        format: false",
          "",
        ].join("\n"),
      );

      execFileSync(
        process.execPath,
        [tspCli, "compile", FIXTURE, "--config", config],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const resolver = path.join(goOut, "renderer_resolver.go");

      // -- rendered-code lock: the emitted resolver is the twin of the shape ----
      // discriminator switch — a generated provider struct with one slot per
      // variant, a runtime completeness guard, and a ResolveRenderer switch keyed
      // on the same `kind`.
      const resolverSrc = readFileSync(resolver, "utf8");
      assert.match(resolverSrc, /type RendererProvider struct/);
      assert.match(resolverSrc, /Mustache\s+Renderer/);
      assert.match(resolverSrc, /Jinja2\s+Renderer/);
      assert.match(resolverSrc, /Liquid\s+Renderer/);
      assert.match(
        resolverSrc,
        /func NewRendererProvider\(impls map\[string\]Renderer\) \(RendererProvider, error\)/,
      );
      assert.match(resolverSrc, /is missing @dispatch variant/);
      assert.match(
        resolverSrc,
        /func ResolveRenderer\(kind string, registry RendererProvider\) \(Renderer, error\)/,
      );
      assert.match(resolverSrc, /case "mustache":\s*\n\s*return registry\.Mustache, nil/);
      // Closed dispatch: an unknown discriminator is a hard error, never a silent
      // nil miss.
      assert.match(
        resolverSrc,
        /unknown Renderer discriminator field 'kind' value/,
      );

      // Feed the proof the committed vectors that carry a scalar `expected`, and
      // extract each vector's discriminator the same way @dispatch resolves it
      // (agent.template.format.kind) so the route rides the real key.
      const snapshot = JSON.parse(
        readFileSync(
          path.join(emitRoot, ".typra-generated", "vectors.json"),
          "utf8",
        ),
      ) as { vectors: { vector: Record<string, unknown> }[] };
      const vectors = snapshot.vectors
        .map((entry) => entry.vector)
        .filter((vector) => typeof vector.expected === "string")
        .map((vector) => {
          const input = vector.input as {
            agent: {
              template?: { format?: { kind?: string } };
            };
            inputs: unknown;
          };
          return {
            name: vector.name as string,
            agent: JSON.stringify(input.agent),
            inputs: JSON.stringify(input.inputs),
            kind: input.agent.template?.format?.kind ?? "",
            expected: vector.expected as string,
          };
        });
      assert.ok(vectors.length >= 2, "fixture must carry routed vectors");
      assert.ok(
        vectors.every((v) => v.kind.length > 0),
        "every routed vector must carry a discriminator",
      );

      // Assemble a self-contained Go module: the emitted model library (which now
      // carries the RendererProvider + ResolveRenderer) under fixtures/, a local
      // yaml.v3 stub, and the consumer proof under proof/.
      const moduleDir = path.join(output, "module");
      const fixturesDir = path.join(moduleDir, "fixtures");
      const yamlDir = path.join(moduleDir, "yamlv3");
      const proofDir = path.join(moduleDir, "proof");
      mkdirSync(fixturesDir, { recursive: true });
      mkdirSync(yamlDir, { recursive: true });
      mkdirSync(proofDir, { recursive: true });

      for (const file of readdirSync(goOut)) {
        if (file.endsWith(".go")) {
          copyFileSync(path.join(goOut, file), path.join(fixturesDir, file));
        }
      }

      writeFileSync(
        path.join(moduleDir, "go.mod"),
        [
          `module ${MODULE}`,
          "",
          "go 1.22",
          "",
          "require gopkg.in/yaml.v3 v3.0.0",
          "",
          "replace gopkg.in/yaml.v3 => ./yamlv3",
          "",
        ].join("\n"),
      );
      writeFileSync(
        path.join(yamlDir, "go.mod"),
        "module gopkg.in/yaml.v3\n\ngo 1.22\n",
      );
      writeFileSync(path.join(yamlDir, "yaml.go"), YAML_STUB);
      writeFileSync(path.join(proofDir, "proof_test.go"), proofTest(vectors));

      const result = runGoTest(moduleDir);
      assert.equal(
        result.status,
        0,
        `typed Go resolver proof should pass:\n${result.output}`,
      );
      assert.match(result.output, /--- PASS: TestTypedResolverRoutesEveryVector/);
      assert.match(
        result.output,
        /--- PASS: TestMissingAttachmentIsCollectionError/,
      );
      assert.match(result.output, /--- PASS: TestUnknownDiscriminatorErrors/);
      assert.doesNotMatch(result.output, /--- FAIL/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
