# Typra

Typra turns TypeSpec models into runtime model surfaces. It is intended for
projects that want one TypeSpec source of truth and generated SDK-style model
code, protocol helpers, JSON AST output, generated tests, and reference docs
across multiple runtimes.

The first package in this repository is [`@typra/emitter`](packages/typra-emitter),
a TypeSpec emitter and CLI extracted from Prompty's generic emitter work.

## What Typra owns

Typra owns generic emitter behavior that is not tied to any one product domain:

- Type graph discovery, lowering, and expression expansion.
- TypeSpec decorators such as `@sample`, `@abstract`, `@coerce`,
  `@@factory`, `@@method`, `@@knownAs`, `@@defaultFor`, and `@@protocol`.
- Language emitters for TypeScript, Python, C#, Go, Rust, Markdown, and JSON
  AST output.
- Synthetic TypeSpec fixtures that exercise supported model shapes.
- Generated-file marker and manifest recording infrastructure.

Product-specific TypeSpec contracts and hand-authored runtime adapters should
stay in the consuming product repository. For example, Prompty owns its
conversation, model, event, pipeline, and harness contracts, while Typra owns
the reusable emitter machinery.

## Install

```powershell
npm install --save-dev @typra/emitter @typespec/compiler
```

## TypeSpec configuration

Add `@typra/emitter` to your TypeSpec config:

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

Then import the emitter library from TypeSpec:

```typespec
import "@typra/emitter";

namespace MyProject;
```

Compile with TypeSpec:

```powershell
npx tsp compile ./path/to/main.tsp --config ./tspconfig.yaml
```

## CLI

The package also includes a convenience CLI:

```powershell
npx typra-generate --help
```

## Repository layout

```text
packages\typra-emitter\        TypeSpec emitter package
packages\typra-emitter\src\    Emitter source
packages\typra-emitter\test\   Unit tests
packages\typra-emitter\fixtures\shapes\
                               Synthetic TypeSpec fixture coverage
```

The current fixture emits TypeScript and JSON AST from
`packages\typra-emitter\fixtures\shapes\main.tsp`. It covers scalars, optional
fields, arrays, dictionaries, nested models, and discriminated unions.

## Development

Run the same checks that CI runs:

```powershell
npm ci
npm run build
npm test
npm run generate:fixtures
npm run pack:dry-run
```

After building, check the local CLI with:

```powershell
node packages\typra-emitter\dist\src\cli.js --help
```

## Publishing

`@typra/emitter` is published from the GitHub Actions `Publish` workflow using
npm trusted publishing. Release checklist:

1. Update `packages\typra-emitter\package.json` to a version that has not been
   published.
2. Run `npm ci`, `npm run build`, `npm test`, `npm run generate:fixtures`, and
   `npm run pack:dry-run`.
3. Confirm `npm pack --workspace @typra/emitter --dry-run --json` includes the
   package README, the `typra-generate` bin, and only intended package files.
4. Commit, push, and merge the change to `main`.
5. Run the `Publish` workflow in GitHub Actions.
