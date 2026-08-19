// Copyright (c) Microsoft. All rights reserved.

import type { CallableVectorSnapshot } from "./vector.js";

/**
 * Static coverage gate for the enforced @vector conformance tier.
 *
 * The generated conformance suite fails at runtime when an operation has a
 * vector but no adapter and no waiver. This module lets a build assert the same
 * invariant ahead of time — against a runtime's declared adapter/waiver
 * registry — so a missing adapter is caught in CI rather than only when the
 * suite runs. Waivers must enumerate concrete operations: a wildcard waiver
 * (e.g. `*`) would let a runtime silently drop whole contracts, which defeats
 * the purpose of the tier, so wildcards are rejected.
 */
export interface VectorAdapterCoverageInput {
  snapshot: CallableVectorSnapshot;
  /** Keys registered by the runtime, each `Contract.operation` or bare `operation`. */
  adapterKeys: Iterable<string>;
  /** Explicit waiver keys, each `Contract.operation` or bare `operation`. */
  waiverKeys?: Iterable<string>;
}

export interface VectorAdapterCoverageResult {
  ok: boolean;
  /** Every distinct operation carrying at least one vector, as `Contract.operation`. */
  operations: string[];
  covered: string[];
  waived: string[];
  missing: string[];
  /** Waiver keys that use a wildcard; these are never allowed. */
  wildcardWaivers: string[];
}

function operationKeys(snapshot: CallableVectorSnapshot): string[] {
  const keys = new Set<string>();
  for (const entry of snapshot.vectors) {
    keys.add(`${entry.contract}.${entry.operation}`);
  }
  return [...keys].sort();
}

function bareOperation(operationKey: string): string {
  const index = operationKey.indexOf(".");
  return index === -1 ? operationKey : operationKey.slice(index + 1);
}

export function evaluateVectorAdapterCoverage(
  input: VectorAdapterCoverageInput,
): VectorAdapterCoverageResult {
  const adapters = new Set(input.adapterKeys);
  const rawWaivers = [...(input.waiverKeys ?? [])];
  const wildcardWaivers = rawWaivers.filter((key) => key.includes("*")).sort();
  const waivers = new Set(rawWaivers.filter((key) => !key.includes("*")));

  const operations = operationKeys(input.snapshot);
  const covered: string[] = [];
  const waived: string[] = [];
  const missing: string[] = [];

  for (const operationKey of operations) {
    const bare = bareOperation(operationKey);
    if (adapters.has(operationKey) || adapters.has(bare)) {
      covered.push(operationKey);
    } else if (waivers.has(operationKey) || waivers.has(bare)) {
      waived.push(operationKey);
    } else {
      missing.push(operationKey);
    }
  }

  return {
    ok: missing.length === 0 && wildcardWaivers.length === 0,
    operations,
    covered,
    waived,
    missing,
    wildcardWaivers,
  };
}

/** Human-readable summary of a failing coverage result, for build output. */
export function formatVectorAdapterCoverageFailure(
  result: VectorAdapterCoverageResult,
): string {
  const lines: string[] = [];
  if (result.missing.length > 0) {
    lines.push(
      "Operations with @vector but no adapter and no waiver (register an " +
        "adapter or add an explicit waiver):",
    );
    for (const operationKey of result.missing) {
      lines.push(`  - ${operationKey}`);
    }
  }
  if (result.wildcardWaivers.length > 0) {
    lines.push(
      "Wildcard waivers are not allowed; enumerate each waived operation:",
    );
    for (const key of result.wildcardWaivers) {
      lines.push(`  - ${key}`);
    }
  }
  return lines.join("\n");
}
