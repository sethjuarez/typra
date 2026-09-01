# Typra fixture catalog

Fixtures are organized so every supported semantic feature can be inspected in
isolation while `integration/main.tsp` keeps the broad cross-feature surface.

- `integration/main.tsp` is the broad integration fixture.
- `dispatch-seam/main.tsp` is a dedicated, end-to-end **eyeball** fixture: a full
  model + `@sample` + polymorphic discriminated union + `@dispatch`-keyed seam
  interface + `@vector`s, generated across all targets so the real per-language
  output (polymorphic de/serialization, seam scaffolds, resolved dispatch path in
  the IR surface) can be inspected side by side. See below.
- `features/<feature>/main.tsp` covers one Typra feature area with multiple
  small examples. These fixtures should stay domain-agnostic; they may cover
  real consuming-project shapes, but should not pin to that project's branding.
- `features/<feature>/*-items.tsp` holds imported constants used by the feature
  fixture when a behavior must prove both inline and file-authored payloads.
- `runtimes/<runtime>/<case>/main.tsp` covers intentional runtime-specific
  quirks that are not semantic Typra features.

When a consuming project finds drift, prefer submitting the smallest focused
feature fixture that reproduces the shape. Add a runtime fixture only when the
behavior is genuinely runtime-specific.

## Focused feature fixtures

| Feature area | Fixture | Coverage intent |
| --- | --- | --- |
| Model shapes | `features/model-shapes/main.tsp` | Required, optional, scalar-defaulted fields, typed records, unknown records, and named references. |
| Scalars | `features/scalars/main.tsp` | String, boolean, integer widths, numeric, float32, float64, and unknown values. |
| Collections | `features/collections/main.tsp` | Scalar arrays, model arrays, unknown maps, model maps, and `Record<T> \| Named<T>[]` dual-form collections. |
| Polymorphism | `features/polymorphism/main.tsp` | Closed discriminated unions, abstract open bases, and named open discriminator bases. |
| Enums | `features/enums/main.tsp` | Closed string unions, open string unions, and parse-only aliases. |
| Samples | `features/samples/main.tsp` | Inline `@sample` payloads and imported constant sample payloads with nested items. |
| Vectors | `features/vectors/main.tsp` | Inline `@vector` payloads, imported vector arrays, success expectations, and error expectations. |
| Coercions | `features/coercions/main.tsp` | Scalar-to-model coercions, factories, method stubs, and entry shorthand for named collections. |
| Defaults | `features/defaults/main.tsp` | Explicit scalar defaults, optional collections, and required complex field sample synthesis. |
| Protocols | `features/protocols/main.tsp` | TypeSpec-native interfaces/operations plus runtime cancellation, sync, optional, and effect metadata. |
| Dispatch | `features/dispatch/main.tsp` | Behavioral polymorphic dispatch via `@dispatch`, resolving a discriminator field to a deterministic parameter access path. |
| Provider wire | `features/wire/main.tsp` | Provider-specific names with `@@knownAs` and provider defaults with `@@defaultFor`. |
| Transport | `features/transport/main.tsp` | Path, query, header, cookie, body, status, success/error body envelopes, and wildcard status bodies. |
| Namespaces | `features/namespaces/main.tsp` | Nested namespaces and cross-namespace references. |
| Documentation | `features/docs/main.tsp` | `@doc` metadata and multiline sample text. |
| Typed seam conformance | `features/typed-seam-conformance/main.tsp` | Plain (undispatched) scalar seam whose `@vector`s ride the emitted typed conformance entrypoint (Rust `run_<seam>_conformance<S: <Seam>>`, Go `Run<Seam>Conformance(t, seam)`, TypeScript `run<Seam>Conformance(seam)`), covering `expected` (structural compare) and `expectedError`. Rust gate `rust.vector-conformance-compile` attaches the committed double under `vector-adapters/rust/`; Go gate `go.vector-conformance-compile` attaches `vector-adapters/go/`; TypeScript gate `typescript.vector-conformance-compile` compiles + runs `vector-adapters/typescript/`. |

## Dispatch-seam integration fixture

`dispatch-seam/main.tsp` is a standalone, cross-target fixture built to be _read_.
It stands up the full shape that motivated behavioral dispatch, end to end:

- a polymorphic discriminated union `TemplateFormat` (`@discriminator("kind")` with
  `mustache` / `jinja2` / `liquid` subtypes, each with a variant field),
- container models (`Template`, `Agent`, `Inputs`) carrying `@sample` payloads,
- a `@dispatch(TemplateFormat.kind)` seam interface `Renderer` whose discriminator
  resolves to the deterministic access path `agent.template.format.kind`, and
- `@vector`s exercising the seam.

Regenerate it into `generated/dispatch-seam/<target>` (git-ignored, like all
generated output) with:

```
npm run generate:fixtures:dispatch-seam
```

Worth eyeballing per target: the polymorphic `TemplateFormat` de/serialization
(discriminator-driven load/save), the `Renderer` seam scaffold (key-free at this
stage), `generated/dispatch-seam/.typra-generated/export-surfaces.json` (which
records the resolved `dispatch.path` on every code target), and the **emitted
per-language tests** under `generated/dispatch-seam/<target>/tests/` — the per-model
round-trip tests plus the `vector-conformance` harness and emitted `vector-runner`.

> **The emitted vector-conformance tests are readable but not yet runnable — on
> purpose.** They call `runVector("Renderer", "render", …)` against a single
> adapter table: they do **not** resolve the concrete implementation by the
> `@dispatch` discriminator path, and they import a hand-authored `./vector-adapters`
> module that is not emitted (that runtime seam is Part I). Making the emitted
> harness dispatch-aware — resolve/register by `agent.template.format.kind` — is
> **Part II-B**. No `vector-adapter-path` is set here, so `validate:fixtures` does
> not compile or run this tree.

The same committed spec is compiled in-process and asserted by two tests
(`npm test`), which emit to a temp dir (never committing generated code — the
spec is the durable artifact, the tests are the guard):

- `test/dispatch-seam.integration.test.ts` checks the emitted **shape**: the
  polymorphic dispatch, the key-free seam, and the recorded dispatch path across
  TypeScript / Python / Go.
- `test/dispatch-seam.conformance.test.ts` checks the emitted **behavior**: it
  walks the resolved `agent.template.format.kind` path over each committed
  `@vector` input, dispatches to a per-dialect renderer, and asserts the vector's
  `expected` output — with a negative control proving a non-discriminator path
  misroutes. This is the in-process stand-in for the dispatch routing the emitted
  harness does not do yet, so the resolved path is proven correct now.

> **Scope:** this fixture emits models, seam scaffolds, IR/surface goldens, and the
> (dispatch-unaware) per-language test surface. It intentionally does **not** emit
> the dispatch resolve/registry glue that makes the harness route by discriminator,
> nor does it wire the emitted tests into a compile/run gate — that is the emission
> half (Part II-B).
