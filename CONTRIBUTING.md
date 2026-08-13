# Contributing to Typra

Thanks for contributing! This guide covers the one workflow rule that keeps `@typra/emitter` correct across its
many target languages: **fixes are reproduction-first.**

## Reproduce-before-fix

A codegen bug is only fixed once its reproduction is a permanent test — one that fails before your change and
passes after. When you fix emitter behavior or generated output:

1. **Capture the shape as a fixture.** Add or extend a focused feature fixture under
   `packages/typra-emitter/fixtures/features/<area>/main.tsp` with the smallest TypeSpec that reproduces the
   issue. Keep it domain-agnostic — mirror real consumer shapes without pinning to a downstream project's
   branding. The catalog lives in [`packages/typra-emitter/fixtures/README.md`](packages/typra-emitter/fixtures/README.md).
2. **Assert the corrected output.** Use whichever locks the fix best:
   - an assertion in `packages/typra-emitter/scripts/validate-fixtures.mjs` (IR / export-surface goldens),
   - a committed golden under `generated/fixtures/<lang>` (regenerated with `npm run generate:fixtures`), and/or
   - a unit test under `packages/typra-emitter/test/`.
     When the bug was target-specific (e.g. invalid Rust), assert the **rendered target code**, not just the IR.
3. **Cover runtime behavior with a vector.** If the fix is behaviorally observable, add an executable
   `@vector`/`@sample` (`input` → `expected`/`expectedError`) so conformance — not just codegen — exercises it.

Filing an issue? The [Emitter drift](.github/ISSUE_TEMPLATE/emitter-drift.yml) template asks for exactly the
inputs that become the fixture: a `.tsp` shape, an expected-vs-actual (a would-be vector), and the offending
generated snippet.

## Before you open a PR

Run, from `packages/typra-emitter/`:

```
npm test
npm run validate:fixtures
npm run lint
```

Then add a `## Unreleased` entry to `packages/typra-emitter/CHANGELOG.md`. Versions and tags are managed by
release-please — **do not** hand-edit the package version or the release manifest. Use conventional-commit
messages and PR titles (e.g. `fix(emitter): carry optional/nullable through the native operation seam`).

## Design questions vs. bugs

Not every rejection is a bug — some diagnostics are principled tightenings. If you are unsure whether the
emitter's behavior is intended, open a Discussion for a maintainer ruling before filing a bug; the answer may be
"conform to the blessed pattern."
