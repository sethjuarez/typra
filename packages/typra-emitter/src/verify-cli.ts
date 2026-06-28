#!/usr/bin/env node

import { parseArgs } from "node:util";
import { formatVerifySummary, verifyTypraMetadata } from "./verify/index.js";

const HELP = `
typra-verify - Verify Typra generated metadata drift

Usage:
  npx typra-verify --baseline <dir> --current <dir> [options]

Options:
  --baseline <dir>  Baseline output root or .typra-generated directory (required)
  --current <dir>   Current output root or .typra-generated directory (required)
  --config <file>   Optional verifier config JSON with protectedPaths
  --json            Print machine-readable JSON result
  -h, --help        Show this help message
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      baseline: { type: "string" },
      current: { type: "string" },
      config: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (!values.baseline || !values.current) {
    console.error("Error: --baseline and --current are required.\n");
    console.log(HELP);
    process.exit(1);
  }

  const result = verifyTypraMetadata({
    baselineRoot: values.baseline,
    currentRoot: values.current,
    configPath: values.config,
  });

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    process.stdout.write(formatVerifySummary(result));
  }

  process.exit(result.ok ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
