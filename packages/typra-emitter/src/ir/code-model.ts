import type {
  CallableVectorSnapshot,
  CallableVectorSnapshotEntry,
} from "./vector.js";

export interface CodeModelJsonConstant {
  name: string;
  value: unknown;
}

export interface VectorConformanceCodeModel {
  fileName: string;
  vectors: CallableVectorSnapshotEntry[];
  constants: CodeModelJsonConstant[];
}

/**
 * Build the structural CodeModel for vector conformance generation.
 *
 * Vector `input`/`expected` values are opaque conformance evidence: Typra
 * serializes them into the snapshot and every target compares them
 * structurally against the transcript. They are intentionally NOT typed
 * against the operation's parameters, so this model carries only the opaque
 * payload — it deliberately does not derive model-typed `load()/save()`
 * round-trip cases. Data fidelity of typed model shapes is the job of
 * `@sample` data conformance, not `@vector` callable evidence.
 */
export function buildVectorConformanceCodeModel(
  snapshot: CallableVectorSnapshot,
): VectorConformanceCodeModel {
  return {
    fileName: "vector-conformance",
    vectors: snapshot.vectors,
    constants: [{ name: "vectors", value: snapshot.vectors }],
  };
}
