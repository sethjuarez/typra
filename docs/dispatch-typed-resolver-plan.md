# Plan: Part III — typed `@dispatch` resolver (reusing the polymorphic-dispatch rail)

Status: **landed — typed rail + per-interface typed conformance migrated for all 7
languages.** This document is the source of truth for Part III of the behavioral-dispatch
investment. It continues Part II (`#280` II-A, `#281` II-B, both merged) and implements
the typed-resolver design of issue **`sethjuarez/typra#282`**.

Owner: emitter (`@typra/emitter`). Primary consumer: **Prompty** (`microsoft/prompty`),
which emits a cross-runtime `@vector` conformance harness into 7 runtimes (python,
typescript, csharp, rust, go, java, swift).

## The core idea

Behavioral `@dispatch` (a `Renderer` seam whose concrete impl is selected at runtime by
a discriminator value — `agent.template.format.kind` ∈ {mustache, jinja2, liquid}) is
moved off the stringly-typed runtime dictionary (the `Contract.operation#value` adapter
registry consulted by the emitted `RunVector` harness) and onto the **same
`PolymorphicDispatchDecl` rail the emitter already uses for SHAPES**.

For each dispatched seam every language now emits, as a **library** artifact, the twin of
the shape `Load` switch:

- a **provider type** — one slot per `@dispatch` variant (the discriminator's variants,
  in shape order), and
- a **completeness-checked resolver** — `resolve_renderer(kind, provider)` — that selects
  the consumer-attached `I<Seam>` impl for the resolved discriminator value.

So behavioral dispatch rides the discriminator rail: the resolver `.variants` are the same
variants the shape discriminator lowers, the completeness check is the same "every variant
has a slot" invariant the shape `Load` switch encodes, and `rejectsUnknown` is the faithful
twin of the shape switch's throw arm.

## What landed in Part III (this PR)

Phase 0 — **IR seam.** `CallableDispatch.decl` (`src/ir/callable.ts`) resolves
`discriminator.model` → that model's lowered `polymorphicDispatch`, so behavioral dispatch
is linked to the shape's `PolymorphicDispatchDecl`. `namespace`/`group` and the dispatch
decl are threaded onto `CallableVectorSnapshotEntry` (`src/ir/vector.ts`).
`collectDispatchedContracts()` (deduped by `(namespace, group, contract)`, only entries with
`entry.dispatch?.decl`) is the shared surface all 7 language emitters iterate.

Phases 1–2 — **provider + resolver emission, all 7 languages.** Each language emits the
provider + resolver as a **library** file (e.g. `RendererResolver.cs`, `_renderer_resolver.py`,
the Rust trait provider + `match`, `Record<Kind, Seam>` in TS, interface/`EnumMap` in Java,
protocol/struct in Swift, struct + runtime completeness guard in Go). Enforcement of the
"every variant is attached" invariant is:

| Language | Missing-attachment failure mode |
| --- | --- |
| C#, TypeScript, Java, Rust, Swift | **compile-time** (missing slot → build error) |
| Go, Python | **runtime** (collection/construction guard raises) |

`rejectsUnknown` is `isClosedPolymorphicDispatch(entry.decl)` (`decl.isClosed &&
decl.defaultVariant === null`) across all 7 — the faithful twin of the shape `Load`
default-arm ordering (default → unknown-carrier → throw), proven correct against
`emitLoadKind` (`src/languages/csharp/emitter.ts`).

Each language carries a **permanent proof test** (`test/dispatch-resolver.typed-<lang>.test.ts`)
that compiles/builds the emitted resolver and asserts, on **rendered target code** (not just
IR):

1. **positive** — a full provider routes every committed vector to the impl reproducing the
   vector's `expected`; and
2. **negative** — dropping a provider slot fails to compile (C#/TS/Java/Rust/Swift) or raises
   at collection/construction (Go/Python) — never silently skips.

The §5 test contract is satisfied at both extremes by siblings: `dispatch-resolver.typed-csharp.test.ts`
(compile-fail, CS0535 when the Mustache slot is dropped) and `dispatch-resolver.typed-python.test.ts`
(collection-fail, `ValueError` naming the absent variant). The pre-existing Part II-B
`dispatch-emission.closed-loop.test.ts` still locks the wrong-route decoy control against the
emitted runtime harness.

## Phase 3 — typed conformance migrated; `#value` retained only as the undispatched net

Issue #282 §7 left open: *"Decide whether to fully delete the `#value` runtime dictionary
or retain it strictly for undispatched seams,"* under the constraint *"Undispatched seams:
keep current behavior; no regression. Only dispatched seams change."* Part III resolves it:
**the `#value` runtime dictionary is retained strictly for undispatched seams.**

**Ground truth (established by reading the emitted harness):**

- The `#value` runtime dictionary is the emitted `RunVector` harness's **dispatch branch**:
  for a dispatched vector it resolves the discriminator value off a recorded path and looks up
  a per-key adapter `Contract.operation#<value>` in a runtime-authored registry. Undispatched
  seams use a **separate else-branch** (single-adapter lookup) and never touch the dispatch
  branch.
- A `@dispatch` whose discriminator model is **not** polymorphic carries a path but **no
  `decl`** (`isTypedDispatchEntry(entry) === Boolean(entry.dispatch?.decl)` is false). Such a
  seam stays on the stringly `#value` runner so its conformance is never silently dropped —
  this is why the dispatch branch is a required **undispatched safety net**, not dead code.

**What changed.** Each language's `@vector` conformance emitter now **partitions** its vectors:
typed (polymorphic-`decl`) entries are emitted as **per-interface typed conformance files in
namespace folders** (§8 file-layout parity with the `@sample`/model-test convention), and the
monolithic stringly runner (`VectorConformanceTests` / `vector_conformance_test` /
`test_vector_conformance`) + its `#value` dispatch branch are emitted **only when undispatched
vectors remain**. For a fully-dispatched group (e.g. `dispatch-seam`) **no** stringly artifact
is emitted at all — verified: the emitted tree contains zero `operation#value` routing and zero
monolithic runner files.

Each per-interface conformance file **imports the consumer-attached provider**, **calls the
emitted `resolve_<seam>`** (the twin of the shape `Load` switch), and **invokes the typed seam**
with typed input built from the emitted models' `FromJson`, reading the SAME discriminator the
shape `Load` switch reads through the typed accessor chain. The consumer authors typed seam
impls + a provider **value** outside the emitted tree (`VectorProviders.renderer()` /
`renderer_provider` fixture / `vector_adapters::renderer_provider()` / `rendererProvider`).

**Acceptance gates — all met:**

1. The emitted dispatched conformance imports the provider, calls `resolve_<seam>`, and invokes
   the typed seam with typed input — for all 7 languages (csharp, python, typescript, java,
   swift, go, rust).
2. No emitted **dispatched** conformance file contains `operation#value`; the **undispatched**
   single-adapter else-branch (and its dispatch branch, for non-polymorphic `@dispatch`) is
   preserved unchanged.
3. The §5 negatives hold: the missing-attachment control fails to compile (C#/TS/Java/Rust/Swift)
   or raises at collection/construction (Go/Python), and the wrong-route decoy stays locked in
   `dispatch-emission.closed-loop.test.ts` (all 7 languages now assert typed call sites).
4. Zero-diff double-regen; `npm test`, `npm run validate:fixtures`, `npm run lint` green; the
   #238 idempotency deferral set (rust/rust-serde/swift/swift-codable/java/java-jackson/
   typescript-zod) did not grow.

Part III therefore lands **both** the typed-resolver rail (emission + per-language proofs) and
the typed emitted-conformance migration, and closes #282.

## Hard constraints (unchanged from Parts I/II)

- **Determinism / zero-diff:** regeneration is a no-op; stable ordering + stable strings.
- Repo files are CRLF; the idempotency gate formats emitted copies — the #238 deferrals must
  not grow.
- Python validates via `uv run --python 3.12 --with pydantic --with pytest --with PyYAML python`.
- **Conventional Commits**; release-please owns the version, manifest, and CHANGELOG — never
  hand-edit them.
