# Changelog

All notable changes to `@typra/emitter` are recorded here.

Versions `0.4.3` through `0.4.18` were published from the unmerged branch of PR #36
rather than from `main`, so `main` declared `0.4.2` while npm `latest` was `0.4.18`.
PR #36 has since been merged and `main` is once again the source of truth for releases.

## 0.4.24

### Fixed

- **Rust: an optional union-typed field inside a discriminated variant generated
  uncompilable code** (#78). A variant field whose declared type has no generated
  Rust counterpart — a polymorphic base, a union containing one (`Property |
  Named<Property>`), or `unknown` — is carried as `serde_json::Value`. The variant
  *declaration* ignored `?` while the variant *load* and *save* paths both honoured
  it, so the generated crate failed with `error[E0308]: expected Value, found
  Option<Value>`. An optional variant field is now declared
  `Option<serde_json::Value>`, matching the loader and saver.

  Struct fields are deliberately unchanged: there, `Value::Null` remains the
  "absent" sentinel and the declaration, loader, and saver already agreed.

  Rust-only. It is the only backend that erases these types to a *non-nullable*
  type — Go uses `interface{}`, and C#/TypeScript/Python/Java keep the declared
  class, all of which are already nullable.

### Testing

- `fixtures/shapes/main.tsp` gains an optional union-typed field inside a
  discriminated variant (`FixtureArrayProperty.fallbackItems`), so the fixture gate
  — which compiles the generated Rust — now covers the shape that regressed. Only
  a *required* field of this shape was previously declared, which is why the gate
  never failed. Reverting the fix makes the gate reproduce the original `E0308`.
- Two Rust emitter tests lock the declaration, load, and save sites against each
  other for both the optional and required cases.

## 0.4.23

### Added

- **`@entryShorthand(field)`** — declares which field an immediate scalar entry of a
  name-keyed collection is assigned to. `spec/vectors/model/named_collection_vectors.json`
  requires that "Immediate primitive Property values infer kind and **default** without
  leaking direct-coercion **example** semantics." Previously the target was chosen
  *positionally* — the element's first declared field — which is unsound for a discriminated
  element type, because its first declared field is the discriminator. `inputs: { city:
  "Seattle" }` therefore loaded as `kind: "Seattle"`, a value the element's own validator
  rejects (#76).

  The declaration is required rather than inferred because a bare scalar reaching a type
  *directly* and the same scalar reaching it *as a named-collection entry* are genuinely
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
  the `f32` cast is applied only when the *destination field* is genuinely `f32` rather than
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
  `as_f64().map(|value| value as f32)` line as *expected content*, so the defect was pinned in
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
  not exist: rewriting *only* the vector data from `parameters: {"properties": [...]}` to the
  declared list form `parameters: [...]` took that suite from `0 passed / 28 failed` to
  `28 passed / 0 failed` with no emitter change. `FunctionTool.parameters` is declared
  `Properties` (a named collection), so `{"properties": [...]}` is name-keyed *object* form
  whose single entry holds an array — exactly what
  `spec/vectors/model/named_collection_vectors.json` requires be rejected:

  > Array-valued entries in name-keyed object form are rejected recursively, while arrays in
  > declared entry fields remain valid.

  No test asserted the *accepting* half of that contract, so nothing contradicted the report.
  `test/typescript-emitter.test.ts` now transpiles and executes an emitted collection loader and
  asserts all four cases together: collection-level array form, name-keyed object form, scalar
  shorthand, and the rejected array-under-a-key. Both halves were verified by mutation —
  injecting the claimed defect reproduces the reported wording verbatim.

## 0.4.21

### Fixed

- **C#, Python, and TypeScript no longer conflate `@abstract` with closed** (#59, PR #67).
  An abstract base over an *open* discriminator threw
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
  emit `load()` as *dispatch first, then apply base assignments* — so the base assigns the
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
  validation that runs ahead of the dispatch match. See the note under *Known limitations*
  about the reachability of this defect.

- **Go numeric coercions now match what decoders actually produce** (#39, PR #52).
  `encoding/json` yields `float64` for *every* JSON number and `gopkg.in/yaml.v3` yields
  `int` for integral YAML scalars, so emitted `case int:` / `case float32:` arms matched no
  decoded number at all and fell through to a zero-valued instance. Emitted coercion
  switches now carry decoder-native `case float64:` and `case int:` arms. When a type
  coerces from both an integral and a fractional scalar, the `float64` arm discriminates
  with `v == math.Trunc(v)` — chosen over `v == float64(int64(v))`, which is undefined for
  `|v| >= 2^63`.

- **Generated tests no longer omit required complex fields** (#53, PR #55).
  `buildExamples()` built sample payloads from only those properties carrying `@sample`, so
  a required *complex* property without one was silently dropped — and the emitters' own
  `needsRequiredComplexValidation` then rejected the payload. A generated test could not
  pass its own generated validation. Required complex values are now synthesized
  recursively from the target type's own `@sample`s. This is shared code, so the fix
  reaches Go, Rust, Swift, Java, Python, and TypeScript.

- **TypeScript dictionary tests no longer discard the built example** (#56, PR #57).
  `test-emitter.ts` hardcoded an empty `Record<string, unknown>`. When there is no example
  to build, no dictionary test is emitted at all.

- **Go no longer conflates `@abstract` with closed** (#54, PR #58).
  An abstract base over an *open* discriminator must absorb an unrecognized kind
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

| declaration | input absent | input `[]` | saves as |
| --- | --- | --- | --- |
| `owners?: T[]` | `None` | `Some(vec![])` | key omitted when `None`; `"owners": []` when `Some(vec![])` |
| `defaultOwners?: T[] = #[]` | `vec![]` | `vec![]` | always emitted as `"defaultOwners": []` |

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
