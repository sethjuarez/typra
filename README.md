# Typra

Typra generates typed runtime contracts from TypeSpec. Use it when TypeSpec is
the source of truth for shared model shapes and you need generated model code,
serialization helpers, protocol interfaces, tests, documentation, and a JSON
contract AST across multiple runtimes.

The first package in this repository is
[`@typra/emitter`](packages/typra-emitter), a TypeSpec emitter and CLI extracted
from Prompty's generic emitter work. Typra is emitter/tooling infrastructure; it
does not own product-specific contracts or hand-authored runtime adapters. The
published package is
[`@typra/emitter` on npm](https://www.npmjs.com/package/@typra/emitter).

User-facing docs are available at <https://typra.dev>.

## Why Typra exists

TypeSpec is good at declaring contracts. Typra turns those declarations into the
runtime surfaces developers need to consume the contracts consistently:

- Generated types/classes/structs with JSON and YAML load/save helpers.
- Polymorphic model loading from TypeSpec discriminators.
- Provider wire-name metadata with `@@knownAs` and defaults with
  `@@defaultFor`.
- Parse-only aliases for named string unions with `@parseAlias`.
- Generated protocol interfaces and optional compile-only test scaffolds.
- Deterministic generated metadata and verifier reports for CI review.

Product repositories should keep their domain TypeSpec files, runtime behavior,
and adapters. Typra keeps the reusable emitter behavior.

## Install

```powershell
npm install --save-dev @typra/emitter @typespec/compiler@1.10.0 @typespec/json-schema@1.10.0
```

Typra currently validates against `@typespec/compiler` and
`@typespec/json-schema` `1.10.0`. Unsupported TypeSpec toolchains produce a
diagnostic during emit; use `allow-unsupported-typespec-version: true` only when
you intentionally accept possible generated output churn.

## Quick start

Add the emitter to `tspconfig.yaml`:

```yaml
emit:
  - "@typra/emitter"

options:
  "@typra/emitter":
    emitter-output-dir: "{cwd}/generated"
    root-object: "Todo.Contracts.TodoList"
    root-namespace: "Todo.Contracts"
    deterministic-output: true
    emit-targets:
      - type: TypeScript
        output-dir: "generated/typescript"
        test-dir: "generated/typescript/tests"
        import-path: "../index"
      - type: Python
        output-dir: "generated/python"
        test-dir: "generated/python/tests"
        import-path: "todo_contracts"
      - type: Markdown
        output-dir: "generated/markdown"
```

Create a TypeSpec entry point:

```typespec
import "@typra/emitter";

namespace Todo.Contracts;

model TodoList {
  name: string;
  items: TodoItem[];
}

model TodoItem {
  id: string;
  title: string;
  state: TodoState;
}

@parseAlias("done", #["complete", "completed"])
union TodoState {
  open: "open";
  done: "done";
  archived: "archived";
}
```

Compile with TypeSpec:

```powershell
npx tsp compile ./path/to/main.tsp --config ./tspconfig.yaml
```

Typra emits each requested language under its configured `output-dir`, writes
tests when `test-dir` is set, and always writes generated metadata under the
configured emitter output root.

## Generated output model

Typra starts from `root-object`, resolves the reachable model graph, lowers it to
an internal contract AST, then emits the configured targets. The generated output
is intentionally split from hand-authored runtime code:

- Generated files include Typra ownership markers.
- `.typra-generated/manifest.json` records generated files and metadata.
- `.typra-generated/report.json` records emitted files, skipped empty outputs,
  hygiene policy, warnings, and stale generated-file cleanup decisions.
- `json-ast/model.json` records the lowered contract surface for schema
  evolution and verifier checks.

Set `deterministic-output: true` for committed generated output. That stabilizes
generated metadata, normalizes text artifacts to LF, trims trailing whitespace,
and keeps final newlines stable for CI diffs.

## Core TypeSpec concepts

Typra adds decorators for runtime concerns that TypeSpec does not model by
default:

```typespec
@@knownAs(WireOptions.maxOutputTokens, "openai", "max_completion_tokens");
@@defaultFor(WireOptions.temperature, "openai", 0.2);

model WireOptions {
  maxOutputTokens?: int32;
  temperature?: float32;
}
```

Common decorators:

| Decorator | Purpose |
| --- | --- |
| `@sample` | Supplies generated test/example data for a property. |
| `@abstract` | Marks a model as not directly instantiated. |
| `@@coerce` | Expands scalar input into an object during load. |
| `@@factory` | Generates factory constructors for a model. |
| `@@method` | Generates method signatures or protocol methods. |
| `@@knownAs` | Maps a property to provider-specific wire names. |
| `@@defaultFor` | Records provider-specific required defaults. |
| `@parseAlias` | Accepts alternate input strings for a canonical union value. |
| `@@protocol` | Marks a model as an emitted protocol/interface contract. |

`@parseAlias` is parse-only: loading accepts aliases, but saving emits the
canonical TypeSpec value.

## Emitter options

The root emitter options are:

| Option | Purpose |
| --- | --- |
| `root-object` | Required fully qualified model to generate from. |
| `root-namespace` | Namespace used to resolve and emit the model graph. |
| `root-alias` | Alias for the generated root surface. |
| `additional-roots` | Extra fully qualified roots to generate. |
| `omit-models` | Model names to leave out of generation. |
| `schema-output-dir` | Reserved schema directory for future cleanup flows. |
| `deterministic-output` | Stable metadata and text hygiene for CI diffs. |
| `protected-paths` | Hand-authored paths recorded for verifier boundaries. |
| `hydration-zones` | Extension zones recorded for verifier checks. |
| `allow-unsupported-typespec-version` | Warn on unvalidated TypeSpec versions. |
| `emit-targets` | Language-specific output configuration. |

Each `emit-targets` entry has a required `type` and can set `output-dir`,
`test-dir`, `format`, `import-path`, `package-name`, `namespace`, `alias`,
`enum-parsing`, and `protocol-scaffolds`.

`protocol-scaffolds: "compile-only"` emits test-dir-only implementations that
prove generated `@@protocol`/`@@method` contracts compile. They intentionally
throw or reject when called and are not runtime fakes.

Rust targets can opt into case-insensitive enum/string-union parsing:

```yaml
emit-targets:
  - type: Rust
    output-dir: "generated/rust"
    enum-parsing: "case-insensitive"
```

## Language support

`@typra/emitter` currently emits:

- `TypeScript`: runtime model surfaces, JSON/YAML helpers, generated tests, and
  Vitest-compatible protocol scaffold tests.
- `Python`: dataclass-style model surfaces, JSON/YAML helpers, import-pruned
  output, and generated tests.
- `CSharp`: C# model surfaces, `System.Text.Json` helpers, and generated
  tests/scaffolds.
- `Go`: Go structs with JSON/YAML support, scalar shorthand helpers,
  propagated child-load errors, polymorphic dispatch, and generated tests.
- `Java`: Java model surfaces and generated fixture tests.
- `Rust`: Rust model surfaces with optional case-insensitive enum parsing.
- `Markdown`: reference documentation generated from the contract graph.
- JSON AST: `json-ast/model.json` emitted for every TypeSpec generation.

The fixture validation flow exercises TypeScript, Python, C#, Go, Java, Rust,
Markdown, and JSON AST generation. Go fixture validation includes formatting,
vet, tests, scalar coercion helper coverage, and executable conformance.

## CLI

The package includes convenience binaries:

```powershell
npx typra-generate --help
npx typra-verify --baseline ./baseline --current ./generated
npx typra-consumer-smoke --config ./typra-smoke.json
```

`typra-generate` wraps the TypeSpec emitter for quick local generation.
`typra-verify` compares generated metadata and reports breaking changes,
protected-path touches, stale output, schema evolution, and hydration seams. It
does not delete files.

## Examples and fixtures

The synthetic fixture is the best compact reference for supported shapes:

```text
packages\typra-emitter\fixtures\tspconfig.yaml
packages\typra-emitter\fixtures\shapes\main.tsp
packages\typra-emitter\fixtures\shapes\model\events\session.tsp
packages\typra-emitter\fixtures\shapes\model\pipeline\harness.tsp
```

It covers scalars, arrays, records, nested models, discriminated polymorphism,
closed and open string unions, parse aliases, scalar coercion, factories,
methods, provider wire names, defaults, and protocols.

## Development

Run the same checks that CI runs:

```powershell
npm ci
npm run build
npm test
npm run generate:fixtures
npm run validate:fixtures
npm run pack:dry-run
```

CI also runs a TypeSpec compatibility matrix for each explicitly supported
`@typespec/compiler` and `@typespec/json-schema` version pair. Add a matrix row
before widening the package peer range.

After building, check the local CLI with:

```powershell
node packages\typra-emitter\dist\src\cli.js --help
```

## Publishing

`@typra/emitter` is published from the GitHub Actions `Publish` workflow using
npm trusted publishing. Release checklist:

1. Update `packages\typra-emitter\package.json` to a version that has not been
   published.
2. Run `npm ci`, `npm run build`, `npm test`, `npm run generate:fixtures`,
   `npm run validate:fixtures`, and `npm run pack:dry-run`.
3. Confirm `npm pack --workspace @typra/emitter --dry-run --json` includes the
   package README, the `typra-generate` bin, and only intended package files.
4. Commit, push, and merge the change to `main`.
5. Run the `Publish` workflow in GitHub Actions.
