# @typra/emitter

`@typra/emitter` generates runtime model surfaces from TypeSpec. Use it when
you want TypeSpec to be the source of truth for shared model contracts and need
generated code, tests, JSON AST output, or documentation for one or more
runtimes.

Typra is emitter-only: it generates model/protocol surfaces, but it does not
ship runtime service implementations or product-specific contracts.

## Install

```powershell
npm install --save-dev @typra/emitter @typespec/compiler@1.10.0 @typespec/json-schema@1.10.0
```

Typra currently validates against TypeSpec compiler and JSON schema emitter
`1.10.0`. Unvalidated TypeSpec versions report a clear diagnostic during emit;
set `allow-unsupported-typespec-version: true` only when you intentionally accept
possible generated output churn.

## 0.3.0 release highlights

`0.3.0` adds Java as a generated runtime target and expands executable fixture
confidence across the supported languages:

- Java model emission with `load`, `save`, `fromJson`, `toJson`, provider wire
  mapping, scalar coercion, enum handling, and polymorphic dispatch support.
- Generated Java fixture tests that compile and run during fixture validation.
- Stronger Go fixture tests and runtime behavior for scalar slices, JSON
  round-trips, polymorphic values, and malformed JSON handling.
- Executable cross-language fixture conformance across TypeScript, Python, C#,
  Go, Java, and Rust.
- CI setup for Go and Java toolchains.

## Configure TypeSpec

Add the emitter to `tspconfig.yaml`:

```yaml
emit:
  - "@typra/emitter"

options:
  "@typra/emitter":
    emitter-output-dir: "{cwd}/generated"
    root-object: "MyProject.ApiRoot"
    root-namespace: "MyProject"
    emit-targets:
      - type: TypeScript
        output-dir: "generated/typescript"
        test-dir: "generated/typescript/tests"
        import-path: "../index"
```

Import the emitter library from your TypeSpec entry point:

```typespec
import "@typra/emitter";

namespace MyProject;
```

Compile with TypeSpec:

```powershell
npx tsp compile ./path/to/main.tsp --config ./tspconfig.yaml
```

## CLI

The package includes `typra-generate`, `typra-verify`, and a generic
`typra-consumer-smoke` harness:

```powershell
npx typra-generate --help
npx typra-generate --deterministic -o ./generated
npx typra-verify --baseline ./baseline --current ./generated
npx typra-consumer-smoke --config ./typra-smoke.json
```

`typra-verify` compares committed `.typra-generated` metadata against current
generated metadata and prints deterministic review summaries for exports,
protocols, files, package/module identity, toolchain, protected paths, schema
evolution, stale cleanup dry-runs, hydration seams, and breaking-change
classification. It never deletes files.

## Supported output

Typra includes emitters for:

- TypeScript
- Python
- C#
- Go
- Java
- Rust
- Markdown documentation
- JSON AST

The Typra fixture slice validates TypeScript, Python, C#, Go, Java, Rust,
Markdown, and JSON AST generation from synthetic TypeSpec shapes. Fixture
validation also exercises generated metadata, verifier CLI output, consumer
smoke wiring, and cross-language generated-code compile/test surfaces.

## Generated files

Generated source files include Typra markers, and the emitter records a
generated-file manifest for each output root. Stale-file deletion is not enabled
yet, so Typra will not remove hand-authored runtime files.

For CI or committed generated output, enable deterministic metadata with the
TypeSpec emitter option:

```yaml
options:
  "@typra/emitter":
    deterministic-output: true
```

This keeps `.typra-generated/manifest.json` stable across equivalent
generations by replacing wall-clock `generatedAt` values with a fixed timestamp.
Generated text artifacts are also normalized to LF line endings, trimmed trailing
whitespace, and final newlines. Blank generated artifacts are skipped unless the
file format requires an empty sentinel such as Python `py.typed`.

Rust targets can opt into case-insensitive string-union/enum parsing without
changing the default case-sensitive behavior:

```yaml
emit-targets:
  - type: Rust
    output-dir: generated/rust
    enum-parsing: case-insensitive
```

When enabled, generated Rust `from_str_opt` methods accept enum values with
ASCII case differences while preserving the canonical serialized casing.

Consumers can declare hand-authored boundaries in verifier config:

```json
{
  "protectedPaths": ["src/adapters/**"],
  "hydrationZones": ["src/extensions/**"]
}
```

The emitter records hydration seam metadata for generated protocol adapters, but
runtime behavior remains hand-authored by the consuming project.

## Links

- Repository: <https://github.com/sethjuarez/typra>
- Package: <https://www.npmjs.com/package/@typra/emitter>
