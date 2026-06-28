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
- Rust
- Markdown documentation
- JSON AST

The Typra fixture slice validates TypeScript, Python, C#, Go, Rust, Markdown,
and JSON AST generation from synthetic TypeSpec shapes. Fixture validation also
exercises generated metadata, verifier CLI output, consumer smoke wiring, and
cross-language generated-code compile/test surfaces.

## Generated files

Generated source files include Typra markers, and the emitter records a
generated-file manifest for each output root. Stale-file deletion is not enabled
yet, so Typra will not remove hand-authored runtime files.

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
