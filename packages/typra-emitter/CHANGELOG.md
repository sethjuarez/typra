# Changelog

All notable changes to `@typra/emitter` are recorded here.

Versions `0.4.3` through `0.4.18` were published from the unmerged branch of PR #36
rather than from `main`, so `main` declared `0.4.2` while npm `latest` was `0.4.18`.
PR #36 has since been merged and `main` is once again the source of truth for releases.

## [0.6.2](https://github.com/sethjuarez/typra/compare/v0.6.1...v0.6.2) (2026-08-13)

### Features

- **emitter:** add TypeSpec-native operation decorators for callable runtime effects.
- **fixtures:** replace legacy shape fixtures with feature, integration, and runtime fixture catalogs.
- **docs:** document native callable seams, operation effects, and fixture evidence layout.

## [0.6.1](https://github.com/sethjuarez/typra/compare/v0.6.0...v0.6.1) (2026-08-13)


### Bug Fixes

* validate namespaced rust unknown fixtures ([e494fe8](https://github.com/sethjuarez/typra/commit/e494fe8de1f903e772de4dc196b99ab2dd09ca1f))

## [0.6.0](https://github.com/sethjuarez/typra/compare/v0.5.0...v0.6.0) (2026-08-12)


### Features

* add typescript fetch consumer projection ([8344c29](https://github.com/sethjuarez/typra/commit/8344c29279eef6985086dccf8173e92e31945801))
* add typra v2 contract projection foundations ([6765980](https://github.com/sethjuarez/typra/commit/6765980e1bba85a4e8d216a9af59f870a3fcff59))
* complete transport roadmap slice ([#196](https://github.com/sethjuarez/typra/issues/196)) ([01c279f](https://github.com/sethjuarez/typra/commit/01c279fb10b1d03520ad4394377ed6bab4e49327))

## [0.5.0](https://github.com/sethjuarez/typra/compare/v0.4.31...v0.5.0) (2026-08-09)

### Features

- **emitter:** gate Rust serde serialization option ([512c67d](https://github.com/sethjuarez/typra/commit/512c67d7ba266ae8ed48cf7b18488564b4213a93))
- **java:** add opt-in Jackson serialization ([#152](https://github.com/sethjuarez/typra/issues/152)) ([d7c4155](https://github.com/sethjuarez/typra/commit/d7c4155f89ed719a3df592741328d95de351dba2))
- **python:** add pydantic native serialization option ([655440b](https://github.com/sethjuarez/typra/commit/655440be95b5438379d3a65256b41d72ffa77eda))
- **rust:** complete serde native serialization validation ([1221448](https://github.com/sethjuarez/typra/commit/122144896b541019f474b7281b91cc568a948f0d))
- **swift:** add codable native serialization option ([#162](https://github.com/sethjuarez/typra/issues/162)) ([51f9f40](https://github.com/sethjuarez/typra/commit/51f9f40803f1be9134110f949064f5dedab0140e))
- **typescript:** add zod native serialization option ([#155](https://github.com/sethjuarez/typra/issues/155)) ([d796512](https://github.com/sethjuarez/typra/commit/d796512e7021e6c000c17c7b3226e98692982deb))

### Bug Fixes

- **emitter:** carry open discriminator fallbacks ([5a6ecdb](https://github.com/sethjuarez/typra/commit/5a6ecdb95847225bcb4eae6106e33559156e4c0a))
- **emitter:** enforce discriminator runtime contract ([#158](https://github.com/sethjuarez/typra/issues/158)) ([e38b97f](https://github.com/sethjuarez/typra/commit/e38b97f77194d9ea4851292db0e9350caa71d762))
- **emitter:** harden Swift unknown fallbacks ([#149](https://github.com/sethjuarez/typra/issues/149)) ([090edcc](https://github.com/sethjuarez/typra/commit/090edcc2e4c25ad2f5b89edc5f5c856219a2721a))
- **emitter:** reject invalid discriminator states ([#157](https://github.com/sethjuarez/typra/issues/157)) ([8476b95](https://github.com/sethjuarez/typra/commit/8476b9525f9f5235bcfffcc8a1ef1921d3f52b40))
- **harness:** detect fixture validation under-execution ([266e33c](https://github.com/sethjuarez/typra/commit/266e33cb0ef0d2557febddac3611d794ce543af1))
- **python:** route pydantic validation entry points through typra ([5e9eab6](https://github.com/sethjuarez/typra/commit/5e9eab6e9ba6f972d33927cd9f4506e2f938eb07))

## [0.4.31](https://github.com/sethjuarez/typra/compare/v0.4.30...v0.4.31) (2026-08-09)

### Bug Fixes

- **csharp:** stop folding multiline YAML fixtures and run every generated C# test ([625098b](https://github.com/sethjuarez/typra/commit/625098b1e3c832c6a263eebcf3846a478a0e47bf))
- **csharp:** stop folding multiline YAML fixtures and run every generated C# test ([de356d8](https://github.com/sethjuarez/typra/commit/de356d8428cb73c4cb765bb78a1bd45169cbb79d)), closes [#93](https://github.com/sethjuarez/typra/issues/93) [#94](https://github.com/sethjuarez/typra/issues/94)
- **emitter:** always fail load on a missing required complex field ([2572b95](https://github.com/sethjuarez/typra/commit/2572b9581223ebc729cb9fa8893604a7fe8ddc1a))
- **emitter:** always fail load on a missing required complex field ([a27615c](https://github.com/sethjuarez/typra/commit/a27615ce4fc2bff2c128fc74db0c4af54f256b66)), closes [#104](https://github.com/sethjuarez/typra/issues/104) [#105](https://github.com/sethjuarez/typra/issues/105)
- **emitter:** preserve typed record values ([4763f75](https://github.com/sethjuarez/typra/commit/4763f7555e2c2e657466b63224fbb1aa7d55fc0d))
- **go:** guard math import to named collection shorthand ([#137](https://github.com/sethjuarez/typra/issues/137)) ([2ade20d](https://github.com/sethjuarez/typra/commit/2ade20d1fc1c8991ff1c21dd6673c099c26fa060))
- **java:** absorb unrecognized discriminators on abstract open bases ([#131](https://github.com/sethjuarez/typra/issues/131)) ([fa6cc6a](https://github.com/sethjuarez/typra/commit/fa6cc6a431dbe23b0ee6e77692d405a8f6a90416))
- **java:** escape control characters in generated JSON output ([#128](https://github.com/sethjuarez/typra/issues/128)) ([754b072](https://github.com/sethjuarez/typra/commit/754b072e032620632a3bbcf793dfc47400338481)), closes [#113](https://github.com/sethjuarez/typra/issues/113)
- **python:** emit valid Python literals and substituted factory assertions in generated tests ([b842515](https://github.com/sethjuarez/typra/commit/b8425156cf316484af42f13eed40e14e422ecea6))
- **python:** emit valid Python literals and substituted factory assertions in generated tests ([0f29dca](https://github.com/sethjuarez/typra/commit/0f29dca3cf4284cc18929701f1fd179d2f81438e)), closes [#107](https://github.com/sethjuarez/typra/issues/107)
- **rust:** emit required zero values ([#124](https://github.com/sethjuarez/typra/issues/124)) ([838cb89](https://github.com/sethjuarez/typra/commit/838cb89194df42ef0f861a5278ee72f30360e50f)), closes [#97](https://github.com/sethjuarez/typra/issues/97)
- **testing:** name a concrete variant when the fixture root is a discriminated base ([75a1007](https://github.com/sethjuarez/typra/commit/75a1007aa43cb286cd21d640089a1894f3dfc38f))
- **testing:** name a concrete variant when the fixture root is a discriminated base ([b5a15fc](https://github.com/sethjuarez/typra/commit/b5a15fcf0445b243e4978eaf0bf8f81ad1dbb7a6)), closes [#92](https://github.com/sethjuarez/typra/issues/92)

## 0.4.30

### Fixed

- **The C# backend generated conversion tests that did not compile against its own generated
  models** (#91). `src/languages/csharp/driver.ts` builds its test validations by hand rather
  than through the shared `buildValidations()` in `src/testing/test-context.ts`, and its filter
  consulted only the sample payload — never the node's properties. Any non-object `@sample` key
  became an assertion, including keys that are not members of the emitted class: a polymorphic
  base whose `@sample` carries a subtype payload asserted `instance.Endpoint` on a base that has
  no such property (CS1061), and a complex property populated through a scalar coercion compared
  a string to the complex type, binding the wrong `Assert.Equal` overload (CS1503). The shared
  predicate is now applied, so only genuine scalar and enum properties are asserted. The field
  remains in the generated payload, so the coercion is still exercised — matching Go, Rust,
  Java, TypeScript and Python, which all include the field but skip the assertion.
- **Generated C# factory tests asserted unsubstituted `{param}` templates** (#91). `@factory`
  `sets` values may embed placeholders resolved from the call arguments, but the emitted test
  compared against the raw template, so `FixtureReference.Named("test", "test")` asserted
  `"{id}"` and could never pass. The call arguments are now substituted before the assertion is
  emitted.
- **The C# type map had no entry for `float` or `numeric`, and mapped `number` to 32-bit
  `float`.** C# was the only backend of seven missing these: TypeScript, Python, Go, Rust, Java
  and Swift all resolve `float`, `numeric` and `number` to a 64-bit double, while C# fell
  through to `object` for the first two and silently narrowed the third. All three now map to
  `double`. Generated test literals track the declared width — a fractional literal is suffixed
  `f` only for genuine 32-bit fields, since `0.9f` widens to `0.8999999761581421` and would fail
  its own generated assertion against a `double?`.

### Added

- `fixtures/shapes/main.tsp` now exercises plain `float` and `numeric` scalars, which no fixture
  previously covered — the gap that let the C# numeric defect survive.

## 0.4.29

### Fixed

- **The Rust backend ignored entry shorthand when saving name-keyed collections** (#89).
  A collection entry whose only field was the scalar-coercion target was written back as an
  expanded object — `{"alpha": {"note": "first"}}` — while TypeScript, Python, Go, C#, Java and
  Swift all collapsed it to the bare scalar `{"alpha": "first"}`. Rust honoured `@entryShorthand`
  on load but never on save, so the two halves of the same generated file disagreed and a
  name-keyed collection did not round-trip byte-identically across languages.
  `emitCollectionSaveHelper()` now mirrors the shared save-side contract: when `use_shorthand`
  is set and the only surviving field is the coercion target, the entry collapses back to the
  scalar. Types with no scalar coercion target are unaffected.

### Testing

- The `entry-shorthand` executable-conformance probe, previously asserted only by the Java
  runner, is now asserted by all seven. That was the last remaining gap in per-runner contract
  coverage, and porting it is what surfaced #89 — the third defect in a row found by
  cross-runner parity rather than by consumer feedback.

## 0.4.28

### Fixed

- **Array-element diagnostics lost the element index in the Rust, C# and Swift backends** (#87).
  Loading a list whose second element omitted a required field reported `entries.detail: missing
required field` in those three backends, while TypeScript, Go, Python and Java correctly reported
  `entries[1].detail`. With many entries every failure produced an identical path, so a diagnostic
  could not identify which element was at fault. TypeScript, Go, Python and Java thread a per-element
  context (`atIndex` / `AtIndex` / `at_index`); Rust reused the collection path for every element,
  and C# and Swift passed the parent context unchanged. Their load contexts never defined an index
  helper at all. Rust now formats an indexed path in both the plain-array and named-collection array
  forms, and the C# and Swift load contexts gained the index helper their call sites now use.

### Changed

- The generated executable-conformance runners now assert the element-index contract in all seven
  backends. It was previously asserted only in TypeScript and Go, which is why the Rust, C# and
  Swift regressions went unnoticed — no consuming runtime reads these diagnostic strings, so the
  degradation was invisible downstream in every language.

## 0.4.27

### Fixed

- **`toWire` emitted fields for providers that declare no mapping** (#84). The Swift backend fell
  back to the schema field name for any provider absent from a field's `@knownAs` map, so a payload
  requested for one provider carried fields declared only for another — in the fixture schema an
  `anthropic` payload carried the openai-only `temperature`. A provider with no mappings at all
  received the entire model instead of an empty payload. The Java backend was correct for a
  non-empty unmapped provider but seeded its `include` flag from `target.isEmpty()`, so an empty or
  null provider received every field under its schema name. Both backends now key emission on the
  requested provider actually having a mapping, matching TypeScript, Python, Go, Rust and C#.

### Changed

- Swift gained an executable-conformance runner. It was previously the only conformance-matrix
  target whose static snippet evidence was asserted but whose behaviour was never compared against
  the canonical cross-backend output — which is why the defect above survived. All seven targets are
  now behaviourally verified.
- The `provider-wire-mapping` conformance case previously asserted only the mapped case, leaving the
  omission rule unlocked in every backend. It now asserts the provider-presence check for all seven
  targets, and every executable-conformance runner probes an unmapped provider and an empty provider
  string, both of which must produce an empty payload.

## 0.4.26

### Fixed

- **Generated output was never pruned, so removed types left orphaned files behind** (#82). When a
  type stopped being emitted, its generated source and generated test stayed on disk, kept
  compiling, and kept running — a generated test for a deleted type becomes a phantom failure in
  the consumer that reads as an emitter regression. A run only knows what it emitted, so the
  previous run's manifest is the only record of what used to exist. `pruneStaleGeneratedFiles` now
  reads that manifest before the new one replaces it and removes what the current run no longer
  produces.

  Deletion is ownership-based and mirrors the ladder already used by `removeSkippedGeneratedFile`:
  a file is removed only when the previous manifest recorded it as marker-owned, it is absent from
  this run, and it still carries the generated marker on disk. Editable seams are preserved,
  consumer-replaced files (marker gone) are preserved with a warning, and anything still emitted is
  untouched. An unreadable manifest deletes nothing.

### Changed

- Retired the stubbed `cleanupFlatTypeFiles` no-ops in the csharp, python, rust and typescript
  drivers. They were placeholders waiting on exactly this manifest cleanup, and guessed ownership
  from file names. Pruning is language-agnostic, so the single central pass covers every backend —
  including java and swift, which never had a stub at all.

## 0.4.25

### Fixed

- **C# generated conversion tests omitted required fields and failed against their own generated
  loaders** (#80). `csharp/driver.ts` built test payloads locally from `@sample` decorators alone
  instead of going through `buildBaseTestContext`, so it never ran the `withRequiredComplexSamples`
  completion step the other six backends get. A required complex property carrying no `@sample` was
  silently dropped from the fixture, and the generated validation then rejected the very payload the
  generator produced. In prompty this failed 48 tests across 8 auto-generated test classes.
  `withRequiredComplexSamples` is now exported and C# calls it, threading in the `TypeRegistry` it
  already had — the same resolver every other backend passes.

### Testing

- `test/test-context.test.ts` gained a `csharp driver — generated fixtures satisfy generated loaders`
  block driving the real `renderTests` from `csharp/driver.ts`: one test asserting a required complex
  property reaches the emitted fixture, and a counterpart guard asserting an optional one stays out.
  Covering the driver rather than the shared helper is deliberate — the helper was already correct
  and already tested; the defect was a backend not calling it.

## 0.4.24

### Fixed

- **Rust: an optional union-typed field inside a discriminated variant generated
  uncompilable code** (#78). A variant field whose declared type has no generated
  Rust counterpart — a polymorphic base, a union containing one (`Property |
Named<Property>`), or `unknown` — is carried as `serde_json::Value`. The variant
  _declaration_ ignored `?` while the variant _load_ and _save_ paths both honoured
  it, so the generated crate failed with `error[E0308]: expected Value, found
Option<Value>`. An optional variant field is now declared
  `Option<serde_json::Value>`, matching the loader and saver.

  Struct fields are deliberately unchanged: there, `Value::Null` remains the
  "absent" sentinel and the declaration, loader, and saver already agreed.

  Rust-only. It is the only backend that erases these types to a _non-nullable_
  type — Go uses `interface{}`, and C#/TypeScript/Python/Java keep the declared
  class, all of which are already nullable.

### Testing

- `fixtures/shapes/main.tsp` gains an optional union-typed field inside a
  discriminated variant (`FixtureArrayProperty.fallbackItems`), so the fixture gate
  — which compiles the generated Rust — now covers the shape that regressed. Only
  a _required_ field of this shape was previously declared, which is why the gate
  never failed. Reverting the fix makes the gate reproduce the original `E0308`.
- Two Rust emitter tests lock the declaration, load, and save sites against each
  other for both the optional and required cases.

## 0.4.23

### Added

- **`@entryShorthand(field)`** — declares which field an immediate scalar entry of a
  name-keyed collection is assigned to. `spec/vectors/model/named_collection_vectors.json`
  requires that "Immediate primitive Property values infer kind and **default** without
  leaking direct-coercion **example** semantics." Previously the target was chosen
  _positionally_ — the element's first declared field — which is unsound for a discriminated
  element type, because its first declared field is the discriminator. `inputs: { city:
"Seattle" }` therefore loaded as `kind: "Seattle"`, a value the element's own validator
  rejects (#76).

  The declaration is required rather than inferred because a bare scalar reaching a type
  _directly_ and the same scalar reaching it _as a named-collection entry_ are genuinely
  different contexts that may populate different fields — the vector requires `default` set
  **and** `example` absent, which one `@coerce` table cannot express. The constant
  assignments are still inferred from the type's own `@coerce` table.

  Undeclared schemas keep their previous shape.

### Fixed

- **Entry shorthand is emitted by every backend**, not just Rust. Go, TypeScript, Python,
  C# and Java now expand an immediate scalar entry identically. Swift is unaffected: it
  emits no load-side named-collection shorthand.

- **Coercion constants keep their declared type.** Constants were stringified during
  lowering and re-quoted by each emitter, so a schema expanding into a boolean or numeric
  constant emitted the string `"true"`. Each backend now renders the literal in its own
  native syntax (`True`/`None` in Python, `nil` in Go, and so on).

- **Scalar classification covers the whole TypeSpec numeric tower.** The integral and
  fractional sets were duplicated per backend and covered only `integer`/`int32`/`int64`
  and the float family, so a schema declaring `int16`, `uint32`, `safeint`, `decimal` or a
  string-encoded scalar such as `utcDateTime` produced no runtime arm at all — a silent
  degradation rather than an error. The sets now live in one place
  (`src/ir/scalar-kinds.ts`) shared by every backend, which also removes the per-backend
  drift that let the coercion family diverge in the first place. This additionally widens
  the numeric bridging introduced in 0.4.19.

- **`@entryShorthand` that cannot emit an arm now warns** instead of silently falling back
  to positional assignment — either because the type declares no `@coerce` table, or
  because every declared scalar lacks a distinguishable JSON form.

## 0.4.22

### Fixed

- **Rust no longer loses the primitive kind or the precision of an immediate `Property` scalar**
  (#73). `spec/vectors/model/property_scalar_coercion_vectors.json` requires that direct
  generated-model JSON loading infer "the exact primitive kind" and store "the unmodified
  scalar", but the Rust backend reported `4` as `kind: "float"` and stored `3.14` as
  `3.140000104904175`. Two independent defects in one emitted block:

  1. **Kind collapse.** `serde_json::Value::as_f64()` returns `Some` for whole numbers too, and
     the fractional coercion branch was emitted before the integral one, so every integer
     matched float first and the integer branch was unreachable. Which branch won was decided
     by declaration order in the schema, which is not a contract.
  2. **Precision loss.** The fractional branch narrowed through `as f32`;
     `3.140000104904175` is exactly `3.14f32` widened back to `f64`. The destination field is a
     `serde_json::Value`, which holds an `f64` exactly, so the narrowing was gratuitous.

  Numeric coercions are now emitted as one ordered block with the `as_i64()` guard first, and
  the `f32` cast is applied only when the _destination field_ is genuinely `f32` rather than
  whenever the declared coercion scalar is `float32`.

  This is the Rust counterpart of #39 / PR #52, which fixed the same contract in Go. The two
  backends diverge deliberately: Go must reconstruct integrality with `math.Trunc` because
  `encoding/json` decodes every JSON number as `float64`, whereas `serde_json` preserves the
  token's own int/float distinction — a literal `as_f64()` + `trunc()` port stores `4.0` where
  the vector requires `4`.

  For the record, the general Rust numeric mapping was never at fault: `float`, `float64`,
  `number` and `numeric` all map to `f64`, and only an explicitly declared `float32` maps to
  `f32`. The narrowing came from the coercion path alone.

  `scripts/validate-fixtures.mjs` had asserted the lossy
  `as_f64().map(|value| value as f32)` line as _expected content_, so the defect was pinned in
  place by its own gate. That assertion is now inverted into an `assertExcludes`.

  Measured against prompty: `cargo test --no-fail-fast --test property_scalar_coercion_vectors`
  `0 passed / 1 failed` → `1 passed / 0 failed`; the full Rust suite `869 passed / 39 failed` →
  `870 passed / 38 failed`, a single flip in the intended direction. Regeneration touched five
  lines in one file, `model/core/property.rs`.

### Testing

- **Locked the named-collection entry-form contract with an executable test.** A defect report
  claimed the emitted validator rejected the legal collection-level list form of a named
  collection, citing every one of prompty's 28 `agent_vectors` Rust tests failing with
  `tools.parameters.properties: invalid named collection entry category array`. The defect does
  not exist: rewriting _only_ the vector data from `parameters: {"properties": [...]}` to the
  declared list form `parameters: [...]` took that suite from `0 passed / 28 failed` to
  `28 passed / 0 failed` with no emitter change. `FunctionTool.parameters` is declared
  `Properties` (a named collection), so `{"properties": [...]}` is name-keyed _object_ form
  whose single entry holds an array — exactly what
  `spec/vectors/model/named_collection_vectors.json` requires be rejected:

  > Array-valued entries in name-keyed object form are rejected recursively, while arrays in
  > declared entry fields remain valid.

  No test asserted the _accepting_ half of that contract, so nothing contradicted the report.
  `test/typescript-emitter.test.ts` now transpiles and executes an emitted collection loader and
  asserts all four cases together: collection-level array form, name-keyed object form, scalar
  shorthand, and the rejected array-under-a-key. Both halves were verified by mutation —
  injecting the claimed defect reproduces the reported wording verbatim.

## 0.4.21

### Fixed

- **C#, Python, and TypeScript no longer conflate `@abstract` with closed** (#59, PR #67).
  An abstract base over an _open_ discriminator threw
  `Unknown Connection discriminator field 'kind' value: future-auth` instead of absorbing
  the unrecognized kind. This completes the reject-before-the-open-fallback family — #37,
  #38, #54, #59 — four instances across four backends, which is what motivated the
  cross-backend audit in `0.4.19`.

  Each backend now emits a concrete `UnknownX` carrier for abstract bases whose
  discriminator is open, sharing the predicate Go already used: TypeScript
  `export class UnknownX extends X`, C# `public sealed partial class UnknownX : X`,
  Python `@dataclass class UnknownX(X)`.

  A subclass was chosen over dropping `abstract` from the base. Rust and Swift model
  polymorphism as enums, where an `Unknown` variant is natural; these three model it as
  class inheritance, so the faithful analogue is a concrete subclass. Dropping `@abstract`
  would silently discard the schema author's intent.

  The carrier needs no `kind` field and no `save()` override, because all three backends
  emit `load()` as _dispatch first, then apply base assignments_ — so the base assigns the
  unrecognized discriminator after dispatch, and the base's `save()` re-emits the preserved
  payload from `raw`. This ordering was verified against generated fixture output for each
  backend rather than assumed from TypeScript.

  Authority is `spec/vectors/model/connection_roundtrip_vectors.json` in `microsoft/prompty`,
  which requires preserving the exact kind and the complete payload — including explicit
  nulls, and without case-folding `"Reference"` to `"reference"`.

### Changed

- `raw`/`_raw` and the raw-clone helpers are now `protected` rather than `private` in the
  TypeScript and C# emitters, so the carrier subclass can reach them.

## 0.4.20

### Fixed

- **TypeScript no longer emits a generated test file with no test cases** (PR #64).
  An abstract type carrying no `@sample` on any property skipped every emitted block:
  the construction and save tests are gated on `!node.isAbstract`, and the JSON, YAML,
  alternate-representation and dictionary-load tests are gated on `examples.length > 0`.
  What reached disk was a bare `describe("X", () => {});`, which vitest **fails**
  outright. Confirmed in `microsoft/prompty` as suite-level collection failures in
  `tests/model/conversation/content-part.test.ts` and
  `tests/model/events/stream-chunk.test.ts` after regenerating against `0.4.19`.

  Such a type now emits a `should be defined` case, asserting the only property still
  meaningful for a type that can be neither constructed nor loaded — that it is
  exported and reachable. Emitting no file was rejected because consumers track these
  paths in git and regeneration does not prune stale output.

  This defect predates `0.4.19`; it became visible only when prompty's regeneration
  moved several types to `@abstract`.

## 0.4.19

First release cut from `main` since `0.4.2`. Contains every fix that had accumulated
behind the stack of unmerged pull requests.

### Fixed

- **Non-abstract polymorphic bases now absorb unclaimed discriminator values** (#37, PR #50).
  A closed discriminator union is not the same thing as an exhaustive dispatch. When a
  non-abstract base's union permits a value that no subtype claims, that value now loads
  as the base type instead of failing. Previously Go returned a zero-valued instance and
  Rust panicked.

- **Open discriminators no longer pre-validate the discriminator field** (Rust, #38, PR #51).
  `emitInputValidation` now excludes the discriminator's own assignment from the base field
  validation that runs ahead of the dispatch match. See the note under _Known limitations_
  about the reachability of this defect.

- **Go numeric coercions now match what decoders actually produce** (#39, PR #52).
  `encoding/json` yields `float64` for _every_ JSON number and `gopkg.in/yaml.v3` yields
  `int` for integral YAML scalars, so emitted `case int:` / `case float32:` arms matched no
  decoded number at all and fell through to a zero-valued instance. Emitted coercion
  switches now carry decoder-native `case float64:` and `case int:` arms. When a type
  coerces from both an integral and a fractional scalar, the `float64` arm discriminates
  with `v == math.Trunc(v)` — chosen over `v == float64(int64(v))`, which is undefined for
  `|v| >= 2^63`.

- **Generated tests no longer omit required complex fields** (#53, PR #55).
  `buildExamples()` built sample payloads from only those properties carrying `@sample`, so
  a required _complex_ property without one was silently dropped — and the emitters' own
  `needsRequiredComplexValidation` then rejected the payload. A generated test could not
  pass its own generated validation. Required complex values are now synthesized
  recursively from the target type's own `@sample`s. This is shared code, so the fix
  reaches Go, Rust, Swift, Java, Python, and TypeScript.

- **TypeScript dictionary tests no longer discard the built example** (#56, PR #57).
  `test-emitter.ts` hardcoded an empty `Record<string, unknown>`. When there is no example
  to build, no dictionary test is emitted at all.

- **Go no longer conflates `@abstract` with closed** (#54, PR #58).
  An abstract base over an _open_ discriminator must absorb an unrecognized kind
  losslessly, the way Rust's `Unknown { kind_name, raw }` variant does. Go emitted
  `fmt.Errorf("unknown ... discriminator")` instead, and its struct had no `raw` field to
  round-trip the payload with. Both halves are fixed. C#, Python, and TypeScript
  followed in `0.4.21` (#59).

- **Diagnostics now carry array element indices** (#47, PR #60).
  A failure in `messages[3]` was reported as just `messages`. Array elements now thread an
  indexed context. Rendering uses bracket notation (`entries[1].detail`) rather than
  dot-joining, because `entries.1` is genuinely ambiguous with a map key named `1` — these
  runtimes accept both the array and the object form for the same field. Adds
  `atIndex` / `at_index` / `AtIndex` to the TypeScript, Python, Java, and Go `LoadContext`
  scaffoldings.

### Changed

- `validate:fixtures` now regenerates before validating (`prevalidate:fixtures`), and
  `npm test` now rebuilds first (`pretest`).

  These are not conveniences. `generated/fixtures` is gitignored, so it never shows up in
  `git status`, and the validation script did not regenerate — it validated whatever was
  last written to disk. Reverting an emitter fix and re-running reported **success**.
  Likewise `npm test` runs the compiled `dist/test/*.test.js`, so editing a test without
  rebuilding silently ran the stale one. Both gates could report green against code that no
  longer existed.

### Added

- Fixture coverage for the defect classes that shipped green (PR #61, PR #62). typra was
  272/0 with `validate:fixtures` clean at `0.4.18` while that version actively broke three
  consumer runtimes; none of the defects above were visible to either gate. New fixtures
  and harness assertions cover: numeric coercions decoded through both `encoding/json` and
  `gopkg.in/yaml.v3`; a closed discriminator union with an unclaimed value; an abstract base
  over an open discriminator; an unrecognized kind on a named open-enum discriminator;
  array-element diagnostic indices; required-complex-field payloads; and all four
  named-collection wire shapes (array, name-keyed, duplicate names, unnamed entries).

## 0.4.15 — breaking change, documented retroactively (#48)

`0.4.15` changed how optional collections are represented, without a note. Recorded here
because it silently broke hand-written code at the generated-model seam in every consuming
runtime, and because the change is conditional in a way that was not obvious.

An optional collection **without** a declared default became optional in the target
language. An optional collection **with** a declared default did not:

```tsp
owners?: FixtureOwner[];              // no default
defaultOwners?: FixtureOwner[] = #[]; // explicit empty default
```

```rust
pub owners: Option<Vec<FixtureOwner>>,   // 0.4.2: Vec<FixtureOwner>
pub default_owners: Vec<FixtureOwner>,   // unchanged
```

### Intended semantics

`None` **is** distinct from `Some(vec![])`, and the wire form preserves the distinction:

| declaration                 | input absent | input `[]`     | saves as                                                    |
| --------------------------- | ------------ | -------------- | ----------------------------------------------------------- |
| `owners?: T[]`              | `None`       | `Some(vec![])` | key omitted when `None`; `"owners": []` when `Some(vec![])` |
| `defaultOwners?: T[] = #[]` | `vec![]`     | `vec![]`       | always emitted as `"defaultOwners": []`                     |

So: declaring a default is a statement that absence and emptiness are the same thing for
that field, and the emitter takes you at your word. Omitting a default is a statement that
they differ, and the emitter preserves the difference through a full round trip. If you
want "empty reads as absent" for a field with no default, that is a consumer-side choice —
in Rust, `self.owners.as_ref().filter(|items| !items.is_empty())`.

### Migration

Every hand-written site touching a defaultless optional collection needs to unwrap. In
prompty's Rust runtime this was `src/model_ext.rs` (`as_inputs()`, `as_outputs()`) and two
assertions in `tests/named_collection_vectors.rs`. The equivalent seams in the Go, C#,
Python, TypeScript, Java, and Swift runtimes have not been built against `0.4.15`+ and are
expected to need the same treatment.

### Process note

A representation change of this kind warrants a minor bump, not a patch bump. Shipping it
as `0.4.14 -> 0.4.15` mid-effort across seven runtimes with no recorded baseline meant the
resulting failures were initially misattributed to pre-existing problems.

## Known limitations

- **#38's reachability.** `resolveUnionProperty` (`src/ir/ast.ts:645-681`) classifies a union
  of string literals plus a bare `string` as `scalar` — never `complex` — and the
  pre-validation branch that #38 describes only fires for `complex`. #51's regression test
  builds the IR by hand with `isScalar` left at its `false` default, a shape the front-end
  does not appear to produce from TypeSpec source. The fix is retained as defensive, but
  the live defect may not have been reachable.

- **#43, #44, #45 remain open and unmeasurable from this side.** They need prompty-side work
  first: prompty's Python package does not build, and prompty has no Swift or Java runtime
  committed.
