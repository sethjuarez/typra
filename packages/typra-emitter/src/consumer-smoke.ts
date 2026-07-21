#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { verifyTypraMetadata } from "./verify/index.js";

interface ConsumerSmokeConfig {
  install?: string[];
  generate?: string[];
  verify?: {
    baseline: string;
    current: string;
    config?: string;
  };
  smoke?: string[];
}

const HELP = `
typra-consumer-smoke - Run a generic Typra consumer smoke harness

Usage:
  npx typra-consumer-smoke --config typra-smoke.json

Config shape:
  {
    "install": ["npm ci"],
    "generate": ["npx tsp compile ./typespec/main.tsp --config ./tspconfig.yaml"],
    "verify": { "baseline": "./baseline", "current": "./generated" },
    "smoke": ["npm test"]
  }
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (!values.config) {
    console.error("Error: --config is required.\n");
    console.log(HELP);
    process.exit(1);
  }

  const configPath = path.resolve(values.config);
  const configDirectory = path.dirname(configPath);
  const config = readConfig(configPath);
  runCommands("install", config.install ?? [], configDirectory);
  runCommands("generate", config.generate ?? [], configDirectory);
  if (config.verify) {
    const result = verifyTypraMetadata({
      baselineRoot: path.resolve(configDirectory, config.verify.baseline),
      currentRoot: path.resolve(configDirectory, config.verify.current),
      configPath: config.verify.config ? path.resolve(configDirectory, config.verify.config) : undefined,
    });
    if (!result.ok) {
      console.error(JSON.stringify(result, null, 2));
      process.exit(1);
    }
  }
  runCommands("smoke", config.smoke ?? [], configDirectory);
}

function readConfig(configPath: string): ConsumerSmokeConfig {
  if (!existsSync(configPath)) {
    throw new Error(`Missing consumer smoke config: ${configPath}`);
  }
  const config = JSON.parse(readFileSync(configPath, "utf8")) as ConsumerSmokeConfig;
  for (const key of ["install", "generate", "smoke"] as const) {
    if (config[key] !== undefined && (!Array.isArray(config[key]) || config[key]?.some((entry) => typeof entry !== "string"))) {
      throw new Error(`Invalid consumer smoke config: ${key} must be an array of commands.`);
    }
  }
  if (config.verify && (typeof config.verify.baseline !== "string" || typeof config.verify.current !== "string")) {
    throw new Error("Invalid consumer smoke config: verify.baseline and verify.current are required strings.");
  }
  return config;
}

function runCommands(label: string, commands: string[], cwd: string): void {
  for (const command of commands) {
    console.log(`[typra-consumer-smoke:${label}] ${command}`);
    execFileSync(command, {
      cwd,
      shell: true,
      stdio: "inherit",
    });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
