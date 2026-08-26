import {
  EmitContext,
  emitFile,
  Operation,
  Program,
  resolvePath,
} from "@typespec/compiler";
import { getStateValue } from "../decorators.js";
import { StateKeys, TypraEmitterOptions } from "../lib.js";
import type { CallableContract, CallableDispatch } from "./callable.js";
import type { PolymorphicDispatchDecl } from "./declarations.js";

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
  namespace: string;
  group: string;
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
            ...(contract.dispatch ? { dispatch: contract.dispatch } : {}),
            vector,
          })),
        ),
      )
      .sort((left, right) => vectorSnapshotKey(left).localeCompare(vectorSnapshotKey(right))),
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
