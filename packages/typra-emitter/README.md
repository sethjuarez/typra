# @typra/emitter

Generic TypeSpec emitter for generating multi-runtime model, protocol, test,
JSON AST, and documentation surfaces from TypeSpec.

## Install

```powershell
npm install --save-dev @typra/emitter
```

## CLI

The package includes the `typra-generate` command:

```powershell
npx typra-generate --help
```

## TypeSpec emitter

Use `@typra/emitter` from TypeSpec configuration to generate runtime surfaces.
The first Typra fixture slice validates TypeScript and JSON AST generation from
synthetic TypeSpec shapes.

## Publishing

This package is published from GitHub Actions using npm Trusted
Publishing/OIDC. Do not use an `NPM_TOKEN` secret for the trusted-publishing
path.
