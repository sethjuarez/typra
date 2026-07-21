#!/usr/bin/env node

import { generate, SUPPORTED_TARGET_LANGUAGES, TargetLanguage } from "./generate.js";
import { parseArgs } from "util";

const HELP = `
typra-generate - Generate Typra runtime surfaces

Usage:
  npx typra-generate [options]

Options:
  -o, --output <dir>       Output directory (required)
  -t, --targets <list>     Comma-separated list of targets (default: python,csharp,typescript,go)
  -s, --spec <path>        TypeSpec entrypoint (default: bundled fixture)
  -r, --root-object <name> Root object to generate from (default: Typra.Fixtures.FixtureRoot)
  --omit <list>            Comma-separated list of models to omit
  -n, --namespace <name>   Root namespace for generated code (default: Typra)
  --no-tests               Skip generating test files
  --no-format              Skip running formatters
  --deterministic          Emit stable generated metadata for CI verification
  -h, --help               Show this help message

Examples:
  # Generate the default runtimes to ./generated
  npx typra-generate -o ./generated

  # Generate only Python and C# 
  npx typra-generate -o ./lib -t python,csharp

  # Generate a different root object
  npx typra-generate -o ./lib --spec ./typespec/main.tsp -r MyProject.Widget

  # Omit specific models
  npx typra-generate -o ./lib --omit LegacyWidget

Targets:
  python       Python dataclasses with YAML/JSON serialization
  csharp       C# classes with System.Text.Json serialization
  typescript   TypeScript interfaces with js-yaml serialization
  go           Go structs with encoding/json and gopkg.in/yaml.v3
  java         Java model surfaces with JSON/YAML serialization
  rust         Rust model surfaces with serde JSON/YAML serialization
  swift        SwiftPM package output with Foundation and Yams
  markdown     Markdown documentation
`;

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      output: { type: "string", short: "o" },
      targets: { type: "string", short: "t" },
      spec: { type: "string", short: "s" },
      "root-object": { type: "string", short: "r" },
      omit: { type: "string" },
      namespace: { type: "string", short: "n" },
      "no-tests": { type: "boolean", default: false },
      "no-format": { type: "boolean", default: false },
      deterministic: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  // Output is required
  const output = values.output || positionals[0];
  if (!output) {
    console.error("Error: Output directory is required. Use -o <dir> or --output <dir>\n");
    console.log(HELP);
    process.exit(1);
  }

  // Parse targets
  const targetsString = values.targets || "python,csharp,typescript,go";
  const targets = targetsString.split(",").map(t => t.trim().toLowerCase()) as TargetLanguage[];

  // Validate targets
  const validTargets: readonly string[] = SUPPORTED_TARGET_LANGUAGES;
  for (const target of targets) {
    if (!validTargets.includes(target)) {
      console.error(`Error: Invalid target "${target}". Valid targets: ${validTargets.join(", ")}`);
      process.exit(1);
    }
  }

  // Parse omit list
  const omit = values.omit ? values.omit.split(",").map(m => m.trim()) : [];

  console.log(`\n🚀 Typra Generator\n`);
  console.log(`  Output:      ${output}`);
  console.log(`  Targets:     ${targets.join(", ")}`);
  console.log(`  Root Object: ${values["root-object"] || "Typra.Fixtures.FixtureRoot"}`);
  if (omit.length > 0) {
    console.log(`  Omitting:    ${omit.join(", ")}`);
  }
  console.log();

  const result = await generate({
    output,
    targets,
    source: values.spec,
    rootObject: values["root-object"] || "Typra.Fixtures.FixtureRoot",
    omit,
    namespace: values.namespace,
    generateTests: !values["no-tests"],
    format: !values["no-format"],
    deterministic: values.deterministic,
  });

  if (result.success) {
    console.log(`✅ Successfully generated code for: ${result.targets.join(", ")}`);
    console.log(`   Output directory: ${result.outputDir}\n`);
    process.exit(0);
  } else {
    console.error(`❌ Generation failed:`);
    result.errors?.forEach(e => console.error(`   - ${e}`));
    process.exit(1);
  }
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
