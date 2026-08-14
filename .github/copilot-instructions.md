# Typra project instructions

- Use `uv run --python 3.12 --with pydantic --with pytest --with PyYAML python` for Python validation, generated Python tests, and executable conformance. Do not invoke `python3` or `python` directly in project scripts or validation notes.

## Conventional commits & the changelog

Commit messages and PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): summary`. release-please reads these from `main` to compute the next version and to
**autogenerate `packages/typra-emitter/CHANGELOG.md`** — so the commit history _is_ the changelog source.

- Common types: `feat` (→ minor bump), `fix` (→ patch bump), plus `refactor`, `perf`, `docs`, `test`,
  `build`, `ci`, `chore` (no release on their own). A breaking change — `type!:` or a `BREAKING CHANGE:`
  footer — forces a major bump.
- Write a real, specific summary — it is what users read in the changelog, e.g.
  `fix(emitter): carry optional/nullable through the native operation seam`.
- This repository **squash-merges**, so the PR title becomes the commit subject release-please parses.
  Keep the PR title conventional (the `Conventional PR title` check lints it); the squashed body may carry
  extra `fix:`/`feat:` lines or a `BREAKING CHANGE:` footer when a single PR warrants multiple entries.
- Do **not** hand-edit `CHANGELOG.md`, the package version, or the release manifest — release-please owns
  all three. A manual `## Unreleased` block is unnecessary and will be ignored by the generated changelog.

## Reproduce-before-fix contract

Every fix that changes emitter behavior or generated output must land with the reproduction encoded as a
permanent test. A bug is not "fixed" until a test that fails on `main` passes on the branch. Concretely:

1. **Capture the shape as a fixture.** Add or extend a focused feature fixture under
   `packages/typra-emitter/fixtures/features/<area>/main.tsp` with the smallest TypeSpec that reproduces the
   drift. Keep fixtures domain-agnostic (no downstream-project branding); mirror real consumer shapes without
   pinning to them. See `fixtures/README.md` for the catalog.
2. **Assert what breaks.** Lock the corrected output with at least one of: an assertion in
   `scripts/validate-fixtures.mjs` (IR / export-surface goldens), a committed golden under
   `generated/fixtures/<lang>` (via `npm run generate:fixtures`), or a unit test under `test/`. Prefer asserting
   the _rendered target code_ when the bug was target-specific (e.g. invalid Rust), not just the IR.
3. **Encode runtime behavior as a vector.** When the fix is behaviorally observable, add an executable
   `@vector`/`@sample` (input → `expected`/`expectedError`) so conformance covers it, not just codegen.

Reported issues should arrive with the same three pieces (see `.github/ISSUE_TEMPLATE/emitter-drift.yml`): a
`.tsp` shape, an expected-vs-actual (a would-be vector), and — ideally — the offending generated snippet. Turn
the report's `.tsp` into the fixture; do not hand-fix without one.

Before finishing an emitter change, run `npm test`, `npm run validate:fixtures`, and `npm run lint`. Commit
messages and PR titles must be Conventional Commits (`type(scope): summary`) — release-please reads them to
compute the next version and to autogenerate the CHANGELOG, so never hand-edit the version, the manifest, or
`CHANGELOG.md`.
