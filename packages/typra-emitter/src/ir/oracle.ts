import type { CallableVectorSnapshotEntry } from "./vector.js";

export interface CallableTranscript {
  vectorId: string;
  target: string;
  input: unknown;
  result?: unknown;
  error?: unknown;
  effects?: unknown[];
  metadata?: Record<string, unknown>;
}

export interface CallableOracleMismatch {
  path: string;
  expected: unknown;
  observed: unknown;
}

export interface CallableOracleResult {
  vectorId: string;
  target: string;
  matched: boolean;
  expected: CallableTranscript;
  observed: CallableTranscript;
  mismatches: CallableOracleMismatch[];
}

export function vectorId(entry: CallableVectorSnapshotEntry): string {
  return `${entry.contract}.${entry.operation}:${entry.vector.name ?? "unnamed"}`;
}

export function expectedTranscript(
  entry: CallableVectorSnapshotEntry,
  target: string,
): CallableTranscript {
  const transcript: CallableTranscript = {
    vectorId: vectorId(entry),
    target,
    input: entry.vector.input,
    metadata: vectorMetadata(entry),
  };

  if ("expected" in entry.vector) {
    transcript.result = entry.vector.expected;
  }
  if ("expectedError" in entry.vector) {
    transcript.error = entry.vector.expectedError;
  }

  return transcript;
}

export function compareCallableTranscript(
  expected: CallableTranscript,
  observed: CallableTranscript,
): CallableOracleResult {
  const mismatches: CallableOracleMismatch[] = [];
  compareValue("vectorId", expected.vectorId, observed.vectorId, mismatches);
  compareValue("target", expected.target, observed.target, mismatches);
  compareValue("input", expected.input, observed.input, mismatches);
  compareValue("result", expected.result, observed.result, mismatches);
  compareValue("error", expected.error, observed.error, mismatches);
  compareValue("effects", expected.effects ?? [], observed.effects ?? [], mismatches);
  compareValue("metadata", expected.metadata, observed.metadata, mismatches);

  return {
    vectorId: expected.vectorId,
    target: expected.target,
    matched: mismatches.length === 0,
    expected,
    observed,
    mismatches,
  };
}

function vectorMetadata(
  entry: CallableVectorSnapshotEntry,
): Record<string, unknown> | undefined {
  const metadata = Object.fromEntries(
    [
      ["stage", entry.vector.stage],
      ["provider", entry.vector.provider],
      ["targetApi", entry.vector.targetApi],
      ["portability", entry.vector.portability],
      ["normalization", entry.vector.normalization],
    ].filter(([, value]) => value !== undefined),
  );
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function compareValue(
  path: string,
  expected: unknown,
  observed: unknown,
  mismatches: CallableOracleMismatch[],
): void {
  if (JSON.stringify(expected) !== JSON.stringify(observed)) {
    mismatches.push({ path, expected, observed });
  }
}
