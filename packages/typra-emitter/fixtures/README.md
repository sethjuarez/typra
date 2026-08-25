# Typra fixture catalog

Fixtures are organized so every supported semantic feature can be inspected in
isolation while `integration/main.tsp` keeps the broad cross-feature surface.

- `integration/main.tsp` is the broad integration fixture.
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
