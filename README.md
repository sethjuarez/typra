# Typra

Typra is a generic TypeSpec emitter for generating multi-runtime model,
protocol, test, JSON AST, and documentation surfaces from TypeSpec. The npm
package is `@typra/emitter`; its CLI entry point is `typra-generate`.

## Ownership boundary

Typra is emitter-only for this first slice. It owns generic emitter behavior:

- TypeSpec decorators such as `@sample`, `@abstract`, `@coerce`,
  `@@factory`, `@@method`, `@@knownAs`, `@@defaultFor`, and `@@protocol`
- Type graph resolution, lowering, expression expansion, and per-language
  emitters
- Synthetic fixtures that exercise generic emitter shapes
- Generated-file marker and manifest recording infrastructure

Prompty keeps its domain TypeSpec and runtime implementation code. Do not copy
Prompty `schema\model` files wholesale into Typra, and do not let Typra cleanup
own or delete hand-authored runtime adapters.

## First fixture slice

The initial fixture emits TypeScript and JSON AST only from
`packages\typra-emitter\fixtures\shapes\main.tsp`. It covers scalars,
optional fields, arrays, dictionaries, nested models, and discriminated unions.

## Local validation

Run the same checks that CI runs:

```powershell
npm ci
npm run build
npm test
npm run generate:fixtures
npm run pack:dry-run
```

After build, the CLI can be checked locally with:

```powershell
node packages\typra-emitter\dist\src\cli.js --help
```

Consumers use it through npm as:

```powershell
npx typra-generate --help
```

## Publishing

Typra publishes `@typra/emitter` from GitHub Actions with npm Trusted
Publishing/OIDC. The npm trusted publisher must match:

| Field | Value |
| --- | --- |
| Publisher | GitHub Actions |
| Repository owner | `sethjuarez` |
| Repository name | `typra` |
| Workflow filename | `publish.yml` |
| Environment name | `npm` |

Release checklist:

1. Update `packages\typra-emitter\package.json` to a version that has not been
   published.
2. Run `npm ci`, `npm run build`, `npm test`, `npm run generate:fixtures`, and
   `npm run pack:dry-run`.
3. Confirm `npm pack --workspace @typra/emitter --dry-run --json` includes the
   `typra-generate` bin and only intended package files.
4. Commit and push the version/package changes.
5. Run the `Publish` workflow in GitHub Actions. It installs, builds, tests,
   generates fixtures, validates the tarball, and publishes with OIDC.

Do not add an `NPM_TOKEN` secret for the trusted-publishing path.
