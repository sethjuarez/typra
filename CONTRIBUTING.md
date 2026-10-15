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

## Emitter capability boundary

Typra projects contracts; it does not generate product algorithms or runtime policy. Before proposing an emitter
capability, read the authoritative [emitter boundary](https://typra.dev/concepts/emitter-boundary/) and classify
the request:

1. **Schema projection:** the behavior is completely and deterministically derivable from TypeSpec, Typra
   decorators, or explicit emitter configuration. It belongs in Typra and needs cross-target fixture evidence.
2. **Mixed:** apply the test only to the generated surface. Typra can generate the types, seam, routing, or
   adapter contract, but a consumer must implement the
   algorithm or policy behind it.
3. **Consumer-owned:** the request is an algorithm or runtime policy—such as parsing, evaluation, retries, token
   acquisition, caching, or persistence. Author, vendor, or transpile it outside generated directories.
4. **Internal emitter infrastructure:** lowering IR, fuzzing, and build/test infrastructure can improve projection
   without introducing a new contract surface. State that explicitly instead of inventing a `.tsp` rule.

The [Emitter capability](.github/ISSUE_TEMPLATE/emitter-capability.yml) form records this classification. A
proposal must identify the contract-derived rule and a target-independent conformance case. If either is
missing, start with a Discussion rather than an implementation issue.

## Commit messages

Commit messages and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): summary`. This is not just style — release-please reads these commits from `main` to decide the
next version and to **autogenerate** [`packages/typra-emitter/CHANGELOG.md`](packages/typra-emitter/CHANGELOG.md).
Your commit summaries are what ships in the changelog, so make them specific.

- **Types:** `feat` (new capability → minor bump), `fix` (bug fix → patch bump), and `refactor` / `perf` /
  `docs` / `test` / `build` / `ci` / `chore` (no release on their own). A breaking change is `type!:` or a
  `BREAKING CHANGE:` footer, which forces a major bump.
- **Example:** `fix(emitter): carry optional/nullable through the native operation seam`.
- This repo **squash-merges**, so your PR title becomes the commit release-please parses — the CI
  `Conventional PR title` check enforces the format. Put additional `fix:`/`feat:` lines (or a
  `BREAKING CHANGE:` footer) in the squash body when one PR should produce more than one changelog entry.

Do **not** hand-edit the package version, the release manifest, or `CHANGELOG.md` — release-please owns all
three, and a manual changelog block will simply be regenerated away.

## Before you open a PR

Run, from `packages/typra-emitter/`:

```
npm test
npm run validate:fixtures
npm run lint
```

## Design questions vs. bugs

Not every rejection is a bug — some diagnostics are principled tightenings. If you are unsure whether the
emitter's behavior is intended—or whether a request crosses the
[emitter boundary](https://typra.dev/concepts/emitter-boundary/)—open a Discussion for a maintainer
ruling before filing a bug; the answer may be "conform to the blessed pattern" or "keep the algorithm
consumer-owned."
