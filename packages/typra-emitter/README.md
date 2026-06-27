# @typra/emitter

`@typra/emitter` generates runtime model surfaces from TypeSpec. Use it when
you want TypeSpec to be the source of truth for shared model contracts and need
generated code, tests, JSON AST output, or documentation for one or more
runtimes.

Typra is emitter-only: it generates model/protocol surfaces, but it does not
ship runtime service implementations or product-specific contracts.

## Install

```powershell
npm install --save-dev @typra/emitter @typespec/compiler
```

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

The package includes the `typra-generate` command:

```powershell
npx typra-generate --help
```

## Supported output

Typra includes emitters for:

- TypeScript
- Python
- C#
- Go
- Rust
- Markdown documentation
- JSON AST

The first Typra fixture slice validates TypeScript and JSON AST generation from
synthetic TypeSpec shapes. Additional fixture coverage will expand as the
extracted emitter hardens.

## Generated files

Generated source files include Typra markers, and the emitter records a
generated-file manifest for each output root. Stale-file deletion is not enabled
yet, so Typra will not remove hand-authored runtime files.

## Links

- Repository: <https://github.com/sethjuarez/typra>
- Package: <https://www.npmjs.com/package/@typra/emitter>
