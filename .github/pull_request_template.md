## What & why

<!-- What does this change and why? Link the issue it fixes. -->

Fixes #

## Reproduction-first checklist

Typra fixes codegen bugs by turning the reproduction into a permanent test. For any change to emitter
behavior or generated output, confirm:

- [ ] A **focused feature fixture** carries the shape (`packages/typra-emitter/fixtures/features/<area>/main.tsp`), or an existing one was extended.
- [ ] A **test asserts the fix** — a `validate-fixtures.mjs` assertion, a golden under `generated/fixtures/<lang>`, and/or a unit test that fails on `main` and passes here.
- [ ] Where behavior is runtime-observable, an executable **`@vector`/`@sample`** encodes input → expected/expectedError.
- [ ] `npm test`, `npm run validate:fixtures`, and `npm run lint` pass.
- [ ] `CHANGELOG.md` updated under `## Unreleased`.

## Notes

<!-- Anything reviewers should know: root cause, alternatives considered, follow-ups. -->
