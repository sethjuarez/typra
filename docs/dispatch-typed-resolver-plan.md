# Plan: Part III — typed `@dispatch` resolver (reusing the polymorphic-dispatch rail)

Status: **rail landed, emitted-conformance migration scoped as the remaining Part III
work.** This document is the source of truth for Part III of the behavioral-dispatch
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

## Phase 3 decision: retain the `#value` conformance-harness runner (for now)

Issue #282 §7 explicitly leaves open: *"Decide whether to fully delete the `#value` runtime
dictionary or retain it strictly for undispatched seams,"* under the constraint *"Undispatched
seams: keep current behavior; no regression. Only dispatched seams change."*

**Ground truth (established by reading the emitted harness):**

- The `#value` runtime dictionary is the emitted `RunVector` harness's **dispatch branch**:
  for a dispatched vector it resolves the discriminator value off a recorded path and looks up
  a per-key adapter `Contract.operation#<value>` in a runtime-authored registry. Undispatched
  seams use a **separate else-branch** (single-adapter lookup) and never touch the dispatch
  branch.
- The resolvers were emitted **additively**. The emitted **conformance harness**
  (`VectorConformanceTests.<lang>` / `test_vector_conformance.py`, one monolithic file per
  language) was **not** rewritten — it still routes dispatched vectors through the `#value`
  dispatch branch. No emitted conformance code calls the emitted resolver; only the sibling
  proof tests do.
- The conformance model has the consumer author **runtime `VectorAdapter`s** (JSON-in/JSON-out
  `invoke`). A typed emitted conformance that consumes the resolver instead needs typed seam
  impls, typed input construction, and typed comparison — a **parallel harness model** and a
  **consumer-authoring-contract change**, replicated across 7 languages, that also rewrites the
  committed §5 closed-loop lock.

**Decision.** Retain the `#value` path as the shared vector-conformance harness runner in this
PR. Do **not** delete the dispatch branch and do **not** rewrite the 7 emitted conformance
harnesses here, because deleting the branch without the conformance rewrite would **regress
dispatched conformance** (the harness would lose its only routing for mustache-vs-jinja2), and
the rewrite's regression surface (the whole conformance suite + validate goldens + the §5 lock)
is disproportionate to land verified, deterministic, and idempotent (no growth of the #238
deferral set) in one pass. "Undispatched behavior must not regress" is honored trivially — the
undispatched else-branch is untouched.

This PR therefore lands the **typed-resolver rail** (emission + per-language proofs) as the
durable Part III output. It does **not** close #282: the emitted-conformance migration below is
the remaining core deliverable.

## Remaining Part III work (follow-up, keep #282 open)

Migrate the emitted **dispatched** conformance to typed call sites and retire the dispatched
`#value` branch. Explicit acceptance gates (per §8 file-layout parity with the `@sample`/model
convention — per-interface files in namespace folders):

1. The emitted dispatched conformance **imports the provider**, **calls `resolve_<seam>`**, and
   **invokes the typed seam** with typed input — for all 7 languages.
2. No emitted **dispatched** conformance file contains `operation#value` (the dispatched branch
   is gone); the **undispatched** single-adapter else-branch is preserved unchanged.
3. The §5 wrong-route negative is re-expressed as a **typed** misroute control (replacing the
   stringly closed-loop decoy), and the missing-attachment negatives (compile-fail /
   collection-fail) remain green.
4. Zero-diff double-regen; `npm test`, `npm run validate:fixtures`, `npm run lint` green; the
   #238 idempotency deferral set (rust/rust-serde/swift/swift-codable/java/java-jackson/
   typescript-zod) does not grow.

## Hard constraints (unchanged from Parts I/II)

- **Determinism / zero-diff:** regeneration is a no-op; stable ordering + stable strings.
- Repo files are CRLF; the idempotency gate formats emitted copies — the #238 deferrals must
  not grow.
- Python validates via `uv run --python 3.12 --with pydantic --with pytest --with PyYAML python`.
- **Conventional Commits**; release-please owns the version, manifest, and CHANGELOG — never
  hand-edit them.
