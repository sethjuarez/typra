# Typra project instructions

- Use `uv run --python 3.12 --with pydantic --with pytest --with PyYAML python` for Python validation, generated Python tests, and executable conformance. Do not invoke `python3` or `python` directly in project scripts or validation notes.
- Use conventional-commit format for PR titles, for example `refactor: extract optional absence field policy`, so the repository's PR title lint check passes.

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

Before finishing an emitter change, run `npm test`, `npm run validate:fixtures`, and `npm run lint`, and add a
`## Unreleased` entry to `packages/typra-emitter/CHANGELOG.md` (release-please manages versions/tags — never
hand-edit the version or manifest).
