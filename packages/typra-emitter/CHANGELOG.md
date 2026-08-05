# Changelog

All notable changes to `@typra/emitter` are recorded here.

Versions `0.4.3` through `0.4.18` were published from the unmerged branch of PR #36
rather than from `main`, so `main` declared `0.4.2` while npm `latest` was `0.4.18`.
PR #36 has since been merged and `main` is once again the source of truth for releases.

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
  round-trip the payload with. Both halves are fixed. C#, Python, and TypeScript remain
  affected — see *Known limitations*.

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

- **#59 — C#, Python, and TypeScript still conflate `@abstract` with closed.** Go was fixed
  in `0.4.19`; the other three emit an "unknown discriminator" error for an unrecognized
  kind on an abstract *open* base. Their fix is not the mechanical predicate flip Go took:
  C# and Python emit genuinely abstract classes, where instantiating the base is a compile
  error, so each needs a concrete `Unknown` carrier of the kind Rust and Swift already have.
  Java and Swift are correct.

- **#38's reachability.** `resolveUnionProperty` (`src/ir/ast.ts:645-681`) classifies a union
  of string literals plus a bare `string` as `scalar` — never `complex` — and the
  pre-validation branch that #38 describes only fires for `complex`. #51's regression test
  builds the IR by hand with `isScalar` left at its `false` default, a shape the front-end
  does not appear to produce from TypeSpec source. The fix is retained as defensive, but
  the live defect may not have been reachable.

- **#43, #44, #45 remain open and unmeasurable from this side.** They need prompty-side work
  first: prompty's Python package does not build, and prompty has no Swift or Java runtime
  committed.
