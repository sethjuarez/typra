import { execFileSync } from "child_process";
import { coerce, eq, satisfies, valid, validRange } from "semver";
import { FormatterCommand, FormatterOption } from "../lib.js";
import {
  warnFormatterUnavailable,
  warnFormatterVersionMismatch,
} from "./formatter-warning.js";

/** Placeholder substitution inputs for a consumer formatter invocation. */
export interface FormatterRunContext {
  /** Primary output directory the formatter should process (`{dir}`). */
  dir: string;
  /** Optional generated test directory (`{testDir}`), when the target emits one. */
  testDir?: string;
}

/**
 * Resolve the consumer-supplied formatter override for a target.
 *
 * Returns `null` when the emitter should run its built-in per-language
 * formatter (the `format: true`/unset default). A returned array means the
 * consumer declared explicit formatter command(s) that replace the built-in
 * post-pass. `format: false` never reaches here — callers gate on it before
 * invoking any formatter.
 */
export function resolveCustomFormatters(
  format: FormatterOption | null | undefined,
): FormatterCommand[] | null {
  if (format === undefined || format === null || typeof format === "boolean") {
    return null;
  }
  const specs = (Array.isArray(format) ? format : [format]).filter(
    (spec): spec is FormatterCommand =>
      !!spec && typeof spec === "object" && typeof spec.command === "string",
  );
  return specs.length > 0 ? specs : null;
}

const VERSION_PATTERN = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/;

function probeVersion(command: string, versionArgs: string[]): string | null {
  try {
    const output = execFileSync(command, versionArgs, {
      stdio: "pipe",
      encoding: "utf-8",
    });
    const match = VERSION_PATTERN.exec(output ?? "");
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

function satisfiesVersion(actual: string, expected: string): boolean {
  // Prefer the version verbatim when it is already valid semver so prerelease
  // identifiers survive (coerce would strip `-beta.1`, silently widening an
  // exact pin and dropping prerelease precision).
  const actualVersion = valid(actual) ?? coerce(actual)?.version ?? null;
  if (!actualVersion) return false;
  if (validRange(expected)) {
    return satisfies(actualVersion, expected);
  }
  const expectedVersion = valid(expected) ?? coerce(expected)?.version ?? null;
  return expectedVersion ? eq(actualVersion, expectedVersion) : false;
}

/**
 * Substitute `{dir}` / `{testDir}` placeholders in a command's args. An
 * argument that references `{testDir}` is dropped entirely when the target has
 * no generated test directory, so a single spec works for targets with and
 * without test output.
 */
export function substituteFormatterArgs(
  args: string[],
  context: FormatterRunContext,
): string[] {
  const substituted: string[] = [];
  for (const arg of args) {
    if (arg.includes("{testDir}") && context.testDir === undefined) {
      continue;
    }
    substituted.push(
      arg
        .replace(/\{dir\}/g, context.dir)
        .replace(/\{testDir\}/g, context.testDir ?? ""),
    );
  }
  return substituted;
}

/**
 * Run consumer-declared formatter command(s) over the emitted tree.
 *
 * Mirrors the built-in post-pass posture: it never fails the emit. A missing
 * binary or non-zero exit is reported through {@link warnFormatterUnavailable}
 * so presence-dependent drift stays attributable, and a declared `version`
 * that the installed tool does not satisfy emits a loud, non-fatal mismatch
 * warning before the command still runs.
 */
export function runCustomFormatters(
  commands: FormatterCommand[],
  context: FormatterRunContext,
): void {
  for (const spec of commands) {
    if (spec.version) {
      const versionArgs = spec["version-args"] ?? ["--version"];
      const actual = probeVersion(spec.command, versionArgs);
      if (actual === null || !satisfiesVersion(actual, spec.version)) {
        warnFormatterVersionMismatch(spec.command, spec.version, actual);
      }
    }

    const args = substituteFormatterArgs(spec.args ?? ["{dir}"], context);
    try {
      execFileSync(spec.command, args, {
        stdio: "pipe",
        encoding: "utf-8",
      });
    } catch (error) {
      warnFormatterUnavailable(spec.command, context.dir, error);
    }
  }
}
