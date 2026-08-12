import {
  EmitContext,
  emitFile,
  Operation,
  Program,
  resolvePath,
} from "@typespec/compiler";
import { getStateValue } from "../decorators.js";
import { StateKeys, TypraEmitterOptions } from "../lib.js";
import type { CallableContract } from "./callable.js";

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
}

export interface CallableVector extends VectorEntry {
  operation: string;
  stage: string;
}

export interface CallableVectorSnapshotEntry {
  contract: string;
  operation: string;
  params: Record<string, string>;
  returns: string;
  vector: CallableVector;
}

export interface CallableVectorSnapshot {
  emitter: "typra-emitter";
  version: 1;
  vectors: CallableVectorSnapshotEntry[];
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
            operation: operation.name,
            params: operation.params,
            returns: operation.returns,
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
