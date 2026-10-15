import {
  EmitContext,
  emitFile,
  Operation,
  Program,
  resolvePath,
} from "@typespec/compiler";
import { getStateValue } from "../decorators.js";
import { EmitTarget, StateKeys, TypraEmitterOptions } from "../lib.js";
import type { CallableContract, CallableDispatch } from "./callable.js";
import {
  explicitDefaultVariant,
  isClosedPolymorphicDispatch,
  type PolymorphicDefault,
  type PolymorphicDispatchDecl,
} from "./declarations.js";
import { scalarRuntimeKind } from "./scalar-kinds.js";

export interface VectorEntry {
  name?: string;
  stage?: string;
  operation?: string;
  input: unknown;
  expected?: unknown;
  expectedError?: unknown;
  provider?: string;
  targetApi?: string;
  portability?: "portable" | "delegated";
  normalization?: unknown;
  /**
   * Ordered list of abstract capability tokens (e.g. `provider:openai`,
   * `entra:foundry-project`, `var:live-enabled`) that must be available for this
   * vector to run. The generated harness resolves each token against the
   * runtime-supplied `VECTOR_CAPABILITIES` table BEFORE invoking the adapter: an
   * unavailable token yields a language-native skip (`requirement unavailable:
   * <token>`), an unregistered token is a hard failure. Tokens are opaque to the
   * emitter — it never parses the `namespace:name` convention.
   */
  requires?: string[];
}

export interface CallableVector extends VectorEntry {
  operation: string;
  stage: string;
}

export interface CallableVectorSnapshotEntry {
  contract: string;
  /**
   * Fully-qualified namespace of the owning seam interface (e.g.
   * `Typra.Sample`). Threaded from the contract node so the conformance-file
   * emitters can reuse the SAME per-group folder helper the model/`@sample`
   * test path already uses (issue §8.4) — one file per interface, placed in its
   * namespace folder, instead of a flat monolith.
   */
  namespace: string;
  /**
   * Semantic group derived from the seam's source subfolder (may be empty).
   * Feeds the same `<lang>GroupFolder` helper as the model test path.
   */
  group: string;
  operation: string;
  params: Record<string, string>;
  returns: string;
  /**
   * Operation classification carried from `@sync`. `false` (the default) marks
   * an async-capable operation; `true` marks a synchronously-callable one. The
   * generated conformance harness reads this to ENFORCE the classification: a
   * `@sync` operation's adapter must resolve synchronously (returning an
   * awaitable is a hard failure), while an async-capable operation stays
   * permissive under the await-if-awaitable contract.
   */
  sync: boolean;
  /**
   * Operation classification carried from the seam op's `optional`/cancellation
   * decorators. `runtimeCancellable` marks an op whose runtime-native signature
   * takes a leading cancellation argument (e.g. Go `ctx context.Context`), and
   * `optional` marks an op the seam may omit. Both are threaded so a downstream
   * emitter (e.g. the typed adapter bridge) can EXCLUDE ops whose native call
   * shape it cannot yet reproduce, instead of emitting a call that fails to
   * compile. Undispatched, non-cancellable, non-optional ops keep the simplest
   * `Method(params...) (T, error)` shape the bridge relies on.
   */
  runtimeCancellable?: boolean;
  optional?: boolean;
  /**
   * Present when the vector's owning seam interface is decorated with
   * `@dispatch`. Carries the discriminator identity plus the deterministic
   * field-access path (e.g. `agent.template.format.kind`) the conformance
   * harness walks over the vector input to select the concrete implementation.
   * Absent for undispatched seams, keeping their snapshot entries
   * byte-identical.
   */
  dispatch?: CallableDispatch;
  vector: CallableVector;
}

export interface CallableVectorSnapshot {
  emitter: "typra-emitter";
  version: 1;
  vectors: CallableVectorSnapshotEntry[];
  /**
   * Sorted simple names of every type in the emitter's `@serializable`
   * serialization closure — the types for which the emitter emits a JSON loader
   * (`load`/`from_json`). Carried in the snapshot so a downstream coverage check
   * (which sees only this artifact, not the TypeSpec registry) can decide whether
   * a model-in/model-out seam is exercised by the EMITTED typed conformance
   * entrypoint (`isTypedSeamEntry`) and therefore needs no hand adapter. Optional
   * so snapshots (and test fixtures) emitted before this field existed still
   * type-check and read cleanly; readers treat its absence as an empty closure.
   */
  serializedTypes?: string[];
  /**
   * `false` when NO emit target emits any typed conformance rail: neither the
   * typed seam entrypoint (`run<Seam>Conformance`) nor the per-interface typed
   * `@dispatch` conformance. Those rails are target-specific (mostly gated on
   * `test-dir`), while this snapshot is target-independent, so a coverage check
   * must not credit `typed` or `dispatched` operations when this is `false`.
   * Written ONLY when `false`; absent means the rails are emitted (and keeps
   * snapshots from before this field, or with a test tree, byte-identical).
   */
  typedConformance?: false;
  /**
   * `false` when some target emits the typed seam entrypoint into its library
   * (C#, Python, Java, Swift do so without `test-dir`) but NO target emits the
   * per-interface typed `@dispatch` conformance (`test-dir`, or Swift's
   * `harness-test-dir`). A coverage check must not credit `dispatched`
   * operations when this is `false`. Written ONLY when `false`.
   */
  dispatchedConformance?: false;
}

/** Which typed conformance rails the configured emit targets actually emit. */
export type ConformanceRailAvailability = Pick<
  CallableVectorSnapshot,
  "typedConformance" | "dispatchedConformance"
>;

/** Targets whose drivers emit typed conformance rails (Markdown emits none). */
const CONFORMANCE_TARGET_TYPES = new Set([
  "typescript",
  "python",
  "go",
  "csharp",
  "java",
  "rust",
  "swift",
]);

/**
 * Library-side typed entrypoint targets: C#, Python and Swift emit
 * `run<Seam>Conformance` into the library unconditionally, Java whenever it has
 * an `output-dir`. TypeScript, Go and Rust emit it only alongside `test-dir`.
 */
function emitsLibraryTypedEntrypoint(
  target: EmitTarget,
  type: string,
): boolean {
  if (type === "csharp" || type === "python" || type === "swift") return true;
  return type === "java" && Boolean(target["output-dir"]);
}

export function conformanceRailAvailability(
  targets: readonly EmitTarget[],
): ConformanceRailAvailability {
  let typed = false;
  let dispatched = false;
  for (const target of targets) {
    const type = target.type.toLowerCase().trim();
    // Every driver emits both rails into `test-dir`; Swift also emits the
    // dispatched conformance into `harness-test-dir` when one is set.
    const codegen = CONFORMANCE_TARGET_TYPES.has(type);
    const testTree =
      (codegen && Boolean(target["test-dir"])) ||
      (type === "swift" && Boolean(target["harness-test-dir"]));
    if (testTree) {
      typed = true;
      dispatched = true;
    } else if (emitsLibraryTypedEntrypoint(target, type)) {
      typed = true;
    }
  }
  return {
    ...(typed ? {} : { typedConformance: false as const }),
    ...(dispatched ? {} : { dispatchedConformance: false as const }),
  };
}

/**
 * One dispatched seam interface distilled from the vector snapshot: the seam
 * contract name, the SAME lowered `PolymorphicDispatchDecl` that drives its
 * shape `Load`/discriminator switch (Phase 0 IR edge), and its namespace/group
 * so each language emitter can place the resolver in the seam's folder.
 */
export interface DispatchedContract {
  contract: string;
  decl: PolymorphicDispatchDecl;
  /**
   * Normalized behavioral openness. Drivers consume this value rather than
   * independently re-interpreting shape-level default/closed flags.
   */
  openness: "closed" | "open";
  /**
   * The single consumer-owned catch-all behavior slot for a schema-declared
   * `*` child. Its API name is deliberately semantic, not derived from a child
   * type such as `CustomModel`.
   */
  wildcard: DispatchWildcardSlot | null;
  namespace: string;
  group: string;
}

export interface DispatchWildcardSlot {
  name: "wildcard";
  variant: PolymorphicDefault;
}

/**
 * Normalize the shape dispatch declaration into the behavioral provider
 * contract shared by all runtime drivers.
 */
export function dispatchBehavior(
  decl: PolymorphicDispatchDecl,
): Pick<DispatchedContract, "openness" | "wildcard"> {
  const wildcardVariant = explicitDefaultVariant(decl);
  return {
    openness: isClosedPolymorphicDispatch(decl) ? "closed" : "open",
    wildcard: wildcardVariant
      ? { name: "wildcard", variant: wildcardVariant }
      : null,
  };
}

/**
 * Collect the distinct dispatched seam interfaces from the vector snapshot,
 * deduped by `(namespace, group, contract)` — the same seam name can recur in
 * different namespaces, and each needs its own resolver — and sorted for
 * zero-diff regen (issue #282 §8.5). Only entries whose `@dispatch` links to a
 * lowered `PolymorphicDispatchDecl` participate; undispatched seams are skipped
 * so their output stays byte-identical. Shared by every language emitter so the
 * Part III resolver rides the SAME rail as the shape discriminator switch.
 */
export function collectDispatchedContracts(
  entries: CallableVectorSnapshotEntry[],
): DispatchedContract[] {
  const byContract = new Map<string, DispatchedContract>();
  for (const entry of entries) {
    const decl = entry.dispatch?.decl;
    if (!decl) continue;
    const key = `${entry.namespace}\u0000${entry.group}\u0000${entry.contract}`;
    if (!byContract.has(key)) {
      byContract.set(key, {
        contract: entry.contract,
        decl,
        ...dispatchBehavior(decl),
        namespace: entry.namespace,
        group: entry.group,
      });
    }
  }
  return [...byContract.values()].sort(
    (left, right) =>
      left.namespace.localeCompare(right.namespace) ||
      left.group.localeCompare(right.group) ||
      left.contract.localeCompare(right.contract),
  );
}

/**
 * Predicate: does this snapshot entry ride the Part III TYPED resolver rail?
 * True only when `@dispatch` resolved to a lowered `PolymorphicDispatchDecl`
 * (the shape-switch twin). A `@dispatch` whose discriminator model is NOT
 * polymorphic carries a path but no `decl`; it stays on the stringly
 * `Contract.operation#value` runner so its conformance is never silently
 * dropped from both rails.
 */
export function isTypedDispatchEntry(
  entry: CallableVectorSnapshotEntry,
): boolean {
  return Boolean(entry.dispatch?.decl);
}

/**
 * A dispatched `@vector` seam-op parameter, classified for the TYPED
 * per-interface conformance emitters. That driver reconstructs each op input
 * from the vector JSON: a MODEL param is decoded through the emitted model
 * loader (`Model.load` / `Model::from_json` / `fixtures.LoadModel` / ...), but a
 * NON-model param — a scalar (`string`), a generic map (`Record<unknown>`), an
 * optional (`T?`), or an array (`T[]`) — has no such loader. Emitting its raw
 * TypeSpec spelling (`Record<unknown>`, `Record<unknown>?`) as a type reference
 * AND as a `<Type>.load(...)` receiver produces uncompilable output in every
 * runtime (`use crate::model::{Record<unknown>?}` breaks `cargo fmt`;
 * `string.load(...)` has no such method). Non-model params must instead be
 * mapped to the target language type + decoded with the native JSON facility,
 * exactly as the per-model test path already does for fields. The driver
 * classifies each param here first.
 */
export interface CallableParamShape {
  /** The raw callable type spelling, e.g. `Agent`, `string`, `Record<unknown>?`. */
  raw: string;
  /** `raw` with a single trailing `?` and/or `[]` stripped. */
  base: string;
  optional: boolean;
  array: boolean;
  /** True when `base` names a model/user type (not a scalar, map, or `unknown`). */
  isModel: boolean;
  /**
   * True only for a BARE model reference (neither optional nor an array). The
   * typed model loader is emitted for exactly this shape; every other shape —
   * including scalars, maps, and optional/array types — rides the native-decode
   * path, since no per-type loader exists for it.
   */
  bareModel: boolean;
}

/**
 * Classify a callable param's raw type spelling (from `typeToCallableName`) as a
 * model reference or a plain (native-decode) type. Mirrors the model-vs-plain
 * split in `extractMethodTypeRefs` (`ir/lower.ts`): a param is a model reference
 * unless its base is a known scalar, a generic (`Record<...>` / `dictionary`),
 * or an untyped intrinsic (`unknown` / `any` / `void`).
 */
export function classifyCallableParam(raw: string): CallableParamShape {
  let base = raw.trim();
  const nullableUnion = /\s*\|\s*(?:null|undefined)$/.exec(base);
  const optional = base.endsWith("?") || nullableUnion !== null;
  if (base.endsWith("?")) {
    base = base.slice(0, -1);
  } else if (nullableUnion) {
    base = base.slice(0, nullableUnion.index).trim();
  }
  const array = base.endsWith("[]");
  if (array) base = base.slice(0, -2);
  const isPlain =
    base === "void" ||
    base === "unknown" ||
    base === "any" ||
    base === "dictionary" ||
    base.includes("<") ||
    scalarRuntimeKind(base) !== null;
  const isModel = !isPlain;
  return {
    raw,
    base,
    optional,
    array,
    isModel,
    bareModel: isModel && !optional && !array,
  };
}

/** Detect a `{ "$env" | "$file" | "$json": "<string>" }` runtime input ref. */
function containsVectorRef(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsVectorRef);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
      keys.length === 1 &&
      (keys[0] === "$env" || keys[0] === "$file" || keys[0] === "$json") &&
      typeof record[keys[0]] === "string"
    ) {
      return true;
    }
    return Object.values(record).some(containsVectorRef);
  }
  return false;
}

/**
 * Guard the TYPED dispatch rail against `@vector` semantics it cannot yet
 * faithfully reproduce. The typed conformance suite builds inputs, routes
 * through the resolver, invokes the seam, and asserts `expected` (or, for an
 * `expectedError` vector, that the invocation throws / returns an error whose
 * message contains the string) — so a vector that leans on the stringly
 * runner's richer machinery (capability gating, normalization, delegated
 * portability, an explicit adapter pick, or `$env`/`$file`/`$json` input refs)
 * would be SILENTLY weakened if emitted on the typed rail. Rather than degrade
 * conformance, we fail loud at emit time with an actionable message. Shared by
 * every language emitter so the safety net is identical across the fan-out
 * (issue #282 §8). Never fires for a plain inline-input + `expected` /
 * `expectedError` dispatched vector.
 */
export function assertTypedDispatchSupported(
  entry: CallableVectorSnapshotEntry,
): void {
  const where = `${entry.contract}.${entry.operation} vector "${
    entry.vector.name ?? "(unnamed)"
  }"`;
  const reject = (reason: string): never => {
    throw new Error(
      `typed @dispatch conformance for ${where} is not supported: ${reason}. ` +
        `Attach it to an undispatched seam or extend the typed rail before ` +
        `emitting (issue #282 §8).`,
    );
  };
  const v = entry.vector;
  if (Array.isArray(v.requires) && v.requires.length > 0) {
    reject(
      "`requires` capability gating is only honored by the stringly runner",
    );
  }
  if (v.normalization !== undefined) {
    reject("`normalization` is applied only by the stringly runner");
  }
  if (v.portability === "delegated") {
    reject("delegated portability is a stringly-runner concern");
  }
  if (v.provider !== undefined) {
    reject(
      "an explicit `provider` pick is meaningless once the resolver selects the impl",
    );
  }
  if (containsVectorRef(v.input)) {
    reject("`$env`/`$file`/`$json` input refs need runtime resolution");
  }
  if (entry.dispatch) {
    const head = entry.dispatch.path.split(".")[0];
    if (!Object.prototype.hasOwnProperty.call(entry.params, head)) {
      reject(
        `discriminator path head "${head}" is not a parameter of this operation`,
      );
    }
  }
}

export function lowerOperationVectors(
  program: Program,
  operation: Operation,
): CallableVector[] {
  const vectors = getStateValue<VectorEntry>(
    program,
    StateKeys.vectors,
    operation,
  );
  if (!Array.isArray(vectors)) return [];

  return vectors.map((vector) => ({
    ...vector,
    operation: vector.operation ?? operation.name,
    stage: vector.stage ?? "callable",
  }));
}

export function buildCallableVectorSnapshot(
  contracts: CallableContract[],
  serializedTypes: ReadonlySet<string> = new Set(),
  rails: ConformanceRailAvailability = {},
): CallableVectorSnapshot {
  return {
    emitter: "typra-emitter",
    version: 1,
    vectors: contracts
      .flatMap((contract) =>
        contract.operations.flatMap((operation) =>
          (operation.vectors ?? []).map((vector) => ({
            contract: contract.name,
            namespace: contract.namespace,
            group: contract.group,
            operation: operation.name,
            params: operation.params,
            returns: operation.returns,
            sync: operation.sync,
            ...(operation.runtimeCancellable
              ? { runtimeCancellable: operation.runtimeCancellable }
              : {}),
            ...(operation.optional ? { optional: operation.optional } : {}),
            ...(contract.dispatch ? { dispatch: contract.dispatch } : {}),
            vector,
          })),
        ),
      )
      .sort((left, right) =>
        vectorSnapshotKey(left).localeCompare(vectorSnapshotKey(right)),
      ),
    serializedTypes: [...serializedTypes].sort(),
    ...(rails.typedConformance === false ? { typedConformance: false } : {}),
    ...(rails.dispatchedConformance === false
      ? { dispatchedConformance: false }
      : {}),
  };
}

export async function emitCallableVectorSnapshot(
  context: EmitContext<TypraEmitterOptions>,
  snapshot: CallableVectorSnapshot,
): Promise<void> {
  await emitFile(context.program, {
    path: resolvePath(
      context.emitterOutputDir,
      ".typra-generated",
      "vectors.json",
    ),
    content: `${JSON.stringify(snapshot, null, 2)}\n`,
  });
}

function vectorSnapshotKey(entry: CallableVectorSnapshotEntry): string {
  return `${entry.contract}:${entry.operation}:${entry.vector.name ?? ""}`;
}

/**
 * Language-agnostic eligibility gate for the typed adapter bridge. A bridge
 * constructor turns a consumer's typed seam impl into the `vectoradapters.Adapter`
 * the conformance runner already consumes, replacing the hand-authored per-op
 * marshalling `Invoke` closure. It is emittable only when the op's native call
 * shape is the plain `Method(params...) (T, error)` the bridge reproduces:
 *
 *  - `dispatch` seams already ride the typed `@dispatch` resolver rail — the
 *    bridge is for the 17 UNdispatched plain seams, so dispatched ops are out.
 *  - `runtimeCancellable` ops carry a leading native cancellation arg (Go
 *    `ctx context.Context`); the bridge does not thread one yet, so calling the
 *    impl would drop an argument and fail to compile. Excluded until the bridge
 *    learns to pass a cancellation token.
 *  - `optional` ops the seam may omit can carry a different native return/error
 *    shape; excluded conservatively for the first slice.
 *
 * The comparator, normalization, `expectedError`, `requires` gating and waivers
 * ALL stay in the runner (the bridge only decodes → calls → returns), so this
 * predicate governs solely whether the CALL shape is reproducible.
 */
export function isBridgeEligible(entry: CallableVectorSnapshotEntry): boolean {
  return !entry.dispatch && !entry.runtimeCancellable && !entry.optional;
}

/**
 * First-slice eligibility for the TYPED conformance entrypoint (issue #511 Cat 1).
 *
 * The typed entrypoint decodes vector input with the target's JSON codec and
 * re-encodes the seam's result for a structural comparison. That round-trip only
 * compiles on targets whose models do NOT carry a native serializer (e.g. the
 * plain non-serde Rust target derives only `Debug, Clone, PartialEq`) when every
 * param and the return are JSON-native SCALARS (strings, integer widths, floats,
 * bool, and their optional/array wrappers). Model params/returns, `Record<…>`,
 * and `unknown` need the model's own loader seam plus structural normalization
 * that is a deferred follow-up, so this slice restricts to fully-scalar seams.
 * Keeping the slice scalar-only also makes it ADDITIVE / zero-diff on real
 * surfaces whose eligible plain seams take model shapes (they are excluded),
 * while a dedicated fixture exercises the typed path red-first. Shared by every
 * language driver so the eligibility rule cannot drift between targets.
 */
export function isScalarSeamEntry(entry: CallableVectorSnapshotEntry): boolean {
  if (!isBridgeEligible(entry)) return false;
  const isScalar = (typeRef: string): boolean =>
    scalarRuntimeKind(classifyCallableParam(typeRef).base) !== null;
  return Object.values(entry.params).every(isScalar) && isScalar(entry.returns);
}

/**
 * Model-parity eligibility for the TYPED conformance entrypoint (issue #511 Cat 1,
 * Phase 2). Widens {@link isScalarSeamEntry} so a param or the return may ALSO be
 * a bare model — but only when that model is a member of the target's
 * `@serializable` serialization closure, i.e. the emitter already emits its JSON
 * loader (`from_json` / `load_from_value`). The typed entrypoint decodes a model
 * vector input and compares an expected model return through THAT loader plus the
 * plain-derive `PartialEq`, so a model outside the closure has no decode primitive
 * and MUST stay adapter/registry-covered. This is the honest reuse invariant: the
 * loader emitted for persistence is the loader conformance decodes with — a type
 * is never pressured into `@serializable` solely to unlock conformance.
 *
 * Superset of {@link isScalarSeamEntry}: a fully-scalar seam is eligible regardless
 * of the closure (scalars carry native JSON codecs).
 *
 * `opts.arrays` (Phase 2 array parity) additionally admits an `Model[]` param or
 * return whose ELEMENT model is in the closure — the entrypoint decodes/compares
 * each element through the same per-model loader lifted over the sequence. It is
 * OPT-IN per driver: a target enables it only once its entrypoint emission grows
 * the element-wise array branch, and the coverage gate enables it only after all
 * targets do, so an array seam is never reported covered before every runtime can
 * decode it. Optional (`Model?`) shapes stay deferred regardless.
 *
 * `opts.carriers` (Phase 2 carrier parity) additionally admits an untyped-carrier
 * PARAM — `Record<…>` / `unknown` / `any` / `dictionary`, optional or not. A
 * carrier has no schema, so the entrypoint decodes it with the target's native
 * untyped-JSON codec (`serde_json::Value`, `map[string]interface{}`, …) and
 * threads the parsed bag straight through to the seam call. It is deliberately
 * PARAM-ONLY: an untyped carrier must NEVER loosen RETURN checking, so the return
 * still rides its scalar / model / array rule (a carrier RETURN stays
 * adapter/registry-covered). This is the shape of prompty's
 * `Renderer.render`/`renderSegments` (non-optional carrier) and `Parser.parse`
 * (optional carrier). Like `arrays`, OPT-IN per driver then per coverage gate.
 */
export function isTypedSeamEntry(
  entry: CallableVectorSnapshotEntry,
  serializedTypeNames: ReadonlySet<string>,
  opts: { arrays?: boolean; carriers?: boolean } = {},
): boolean {
  if (!isBridgeEligible(entry)) return false;
  // An untyped carrier: a plain (native-decode) bag with no schema. Matches the
  // exact plain-but-not-scalar set from `classifyCallableParam` — `unknown` /
  // `any` / `dictionary` or any generic (`Record<…>`, `<`-bearing) — optional or
  // not, but never an array (array-of-carrier is a separate future widening).
  const isCarrier = (shape: CallableParamShape): boolean =>
    !shape.array &&
    (shape.base === "unknown" ||
      shape.base === "any" ||
      shape.base === "dictionary" ||
      shape.base.includes("<"));
  const isTyped = (typeRef: string, allowCarrier: boolean): boolean => {
    const shape = classifyCallableParam(typeRef);
    if (scalarRuntimeKind(shape.base) !== null) return true;
    if (shape.bareModel && serializedTypeNames.has(shape.base)) return true;
    if (
      opts.arrays &&
      shape.array &&
      !shape.optional &&
      shape.isModel &&
      serializedTypeNames.has(shape.base)
    ) {
      return true;
    }
    if (opts.carriers && allowCarrier && isCarrier(shape)) return true;
    return false;
  };
  return (
    Object.values(entry.params).every((typeRef) => isTyped(typeRef, true)) &&
    isTyped(entry.returns, false)
  );
}
