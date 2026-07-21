import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { createRequire } from "module";
import * as YAML from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

export const SUPPORTED_TARGET_LANGUAGES = [
  "python",
  "csharp",
  "typescript",
  "go",
  "java",
  "rust",
  "swift",
  "markdown",
] as const;

/**
 * Target language for code generation.
 */
export type TargetLanguage = typeof SUPPORTED_TARGET_LANGUAGES[number];

/**
 * Options for a specific target language.
 */
export interface TargetOptions {
  /** Output directory for generated code */
  outputDir: string;
  /** Output directory for generated tests (optional) */
  testDir?: string;
  /** Override the namespace for generated code */
  namespace?: string;
  /** Run formatters on emitted files (default: true) */
  format?: boolean;
  /** Enum/string-union parsing policy for targets that support it */
  enumParsing?: "case-sensitive" | "case-insensitive";
}

/**
 * Options for the generate function.
 */
export interface GenerateOptions {
  /** 
   * Output directory for generated code.
   * Each target will create a subdirectory (e.g., output/python, output/csharp)
   */
  output: string;

  /**
   * Target languages to generate code for.
   * @default ["python", "csharp", "typescript", "go"]
   */
  targets?: TargetLanguage[] | Record<TargetLanguage, TargetOptions>;

  /**
   * TypeSpec entrypoint to compile.
   * @default The package's bundled fixture entrypoint.
   */
  source?: string;

  /**
   * Root object to start generation from.
   * @default "Typra.Fixtures.FixtureRoot"
   */
  rootObject?: string;

  /**
   * List of model names to omit from generation.
   * Can be simple names (e.g., "Widget") or fully qualified (e.g., "Typra.Widget")
   */
  omit?: string[];

  /**
   * Root namespace for the generated code.
   * @default "Typra"
   */
  namespace?: string;

  /**
   * Alias for the root object in generated code.
   */
  rootAlias?: string;

  /**
   * Generate test files.
   * @default true
   */
  generateTests?: boolean;

  /**
   * Run formatters on emitted files.
   * @default true
   */
  format?: boolean;

  /**
   * Emit stable metadata for deterministic CI verification.
   * @default false
   */
  deterministic?: boolean;
}

/**
 * Result of the generate function.
 */
export interface GenerateResult {
  success: boolean;
  outputDir: string;
  targets: string[];
  errors?: string[];
}

/**
 * Generate Typra runtime surfaces.
 * 
 * @example
 * ```typescript
 * import { generate } from '@typra/emitter/generate';
 * 
 * await generate({
 *   output: './generated',
 *   targets: ['python', 'csharp'],
 *   rootObject: 'Typra.Widget',
 *   omit: ['LegacyWidget']
 * });
 * ```
 */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const {
    output,
    targets = ["python", "csharp", "typescript", "go"],
    source,
    rootObject = "Typra.Fixtures.FixtureRoot",
    omit = [],
    namespace = "Typra",
    rootAlias,
    generateTests = true,
    format = true,
    deterministic = false,
  } = options;
  const targetNames = Array.isArray(targets) ? targets : Object.keys(targets);
  const unsupportedTargets = targetNames.filter(
    (target): target is string => !SUPPORTED_TARGET_LANGUAGES.includes(target as TargetLanguage),
  );

  if (unsupportedTargets.length > 0) {
    return {
      success: false,
      outputDir: path.resolve(output),
      targets: targetNames,
      errors: [`Unsupported target language(s): ${unsupportedTargets.join(", ")}. Supported targets: ${SUPPORTED_TARGET_LANGUAGES.join(", ")}.`],
    };
  }

  // __dirname is dist/src at runtime, so we need to go up two levels to package root.
  const packageRoot = path.resolve(__dirname, "../..");
  const modelPath = source
    ? path.resolve(source)
    : path.resolve(packageRoot, "fixtures", "shapes", "main.tsp");
  if (!existsSync(modelPath)) {
    return {
      success: false,
      outputDir: path.resolve(output),
      targets: targetNames,
      errors: [`TypeSpec entrypoint does not exist: ${modelPath}`],
    };
  }

  // Ensure output directory exists
  const outputDir = path.resolve(output);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Build emit targets configuration
  const emitTargets = buildEmitTargets(targets, outputDir, generateTests, format);

  // Create temporary tspconfig.yaml
  const tspConfig = {
    emit: ["@typra/emitter"],
    options: {
      "@typra/emitter": {
        "emitter-output-dir": outputDir,
        "root-object": rootObject,
        "root-namespace": namespace,
        ...(rootAlias && { "root-alias": rootAlias }),
        ...(omit.length > 0 && { "omit-models": omit }),
        ...(deterministic && { "deterministic-output": true }),
        "emit-targets": emitTargets,
      },
    },
  };

  // Write temporary config file
  const tempConfigPath = path.join(outputDir, ".tspconfig.temp.yaml");
  writeFileSync(tempConfigPath, YAML.stringify(tspConfig));

  try {
    // Resolve the peer dependency directly so the API and CLI work outside npm scripts.
    execFileSync(process.execPath, [resolveTypeSpecCli(), "compile", modelPath, "--config", tempConfigPath], {
      stdio: "inherit",
      cwd: outputDir,
    });

    return {
      success: true,
      outputDir,
      targets: targetNames,
    };
  } catch (error) {
    return {
      success: false,
      outputDir,
      targets: targetNames,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  } finally {
    // Clean up temp config
    try {
      unlinkSync(tempConfigPath);
    } catch {
      // Ignore cleanup errors
    }

  }
}

function resolveTypeSpecCli(): string {
  const compilerEntry = require.resolve("@typespec/compiler");
  const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
  return path.join(compilerRoot, "cmd", "tsp.js");
}

function buildEmitTargets(
  targets: TargetLanguage[] | Record<TargetLanguage, TargetOptions>,
  baseOutput: string,
  generateTests: boolean,
  format: boolean
): Array<{
  type: string;
  "output-dir": string;
  "test-dir"?: string;
  format?: boolean;
  namespace?: string;
  "enum-parsing"?: "case-sensitive" | "case-insensitive";
}> {
  if (Array.isArray(targets)) {
    // Simple array of target names - use default directories
    return targets.map(target => ({
      type: target,
      "output-dir": path.join(baseOutput, target),
      "test-dir": generateTests ? path.join(baseOutput, target, "tests") : undefined,
      format,
    }));
  } else {
    // Object with per-target configuration
    return Object.entries(targets).map(([target, opts]) => ({
      type: target,
      "output-dir": opts.outputDir,
      "test-dir": opts.testDir,
      format: opts.format ?? format,
      namespace: opts.namespace,
      "enum-parsing": opts.enumParsing,
    }));
  }
}
