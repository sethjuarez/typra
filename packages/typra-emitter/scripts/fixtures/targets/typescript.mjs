import {
  KNOWN_TEST_FAILURES,
  assertKnownTestFailures,
  execFileSync,
  existsSync,
  fail,
  generatedRoot,
  mkdirp,
  mkdtempSync,
  packageRoot,
  path,
  readFileSync,
  rmSync,
  unlinkSync,
  walkFiles,
  writeFileSync,
} from "../harness.mjs";
import {
  assertConformanceResult,
  fixtureRootSampleJsonLiteral,
  imageContentSample,
  propertyCorpusJsonLiteral,
  wireOptionsSample,
} from "../conformance.mjs";
import { WEB_COMPILE_COMPILER_OPTIONS } from "../web-compile-profile.mjs";
import { pathToFileURL } from "node:url";

export function findTypeScriptCli(startDir) {
  let current = startDir;
  while (current !== path.dirname(current)) {
    const candidate = path.join(
      current,
      "node_modules",
      "typescript",
      "bin",
      "tsc",
    );
    if (existsSync(candidate)) {
      return candidate;
    }
    current = path.dirname(current);
  }
  fail(
    "Unable to locate local TypeScript compiler for generated fixture validation.",
  );
  return undefined;
}

export function typeScriptTypeRoots(tscCli) {
  return [path.resolve(path.dirname(tscCli), "..", "..", "@types")];
}

export function runGeneratedTypeScriptCompileFor(targetDir, label) {
  const sourceDir = path.join(generatedRoot, targetDir);
  const sourceFiles = walkFiles(sourceDir, (file) => file.endsWith(".ts"));

  if (sourceFiles.length === 0) {
    fail(`No generated ${label} files found to compile.`);
    return;
  }
  const tscCli = findTypeScriptCli(packageRoot);
  if (!tscCli) return;

  const ambientPath = path.join(sourceDir, "test-globals.validate.d.ts");
  const configPath = path.join(sourceDir, "tsconfig.validate.json");
  writeFileSync(
    ambientPath,
    [
      "declare function describe(name: string, fn: () => void): void;",
      "declare function it(name: string, fn: () => void): void;",
      "declare function expect(actual: unknown): {",
      "  toBeDefined(): void;",
      "  toBe(expected: unknown): void;",
      "  toEqual(expected: unknown): void;",
      "  toBeInstanceOf(expected: unknown): void;",
      "};",
      "",
    ].join("\n"),
  );
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        compilerOptions: {
          noEmit: true,
          target: "ES2022",
          module: "commonjs",
          moduleResolution: "node",
          esModuleInterop: true,
          skipLibCheck: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          types: ["node"],
          typeRoots: typeScriptTypeRoots(tscCli),
          lib: ["ES2022"],
        },
        files: [...sourceFiles, ambientPath],
      },
      null,
      2,
    ),
  );

  try {
    execFileSync(process.execPath, [tscCli, "-p", configPath], {
      cwd: packageRoot,
      stdio: "pipe",
    });
  } catch (error) {
    const output =
      `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(
      `Generated ${label} source and tests do not compile:\n${output || error.message}`,
    );
  } finally {
    for (const tempPath of [configPath, ambientPath]) {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    }
  }
}

export function runGeneratedTypeScriptCompile() {
  runGeneratedTypeScriptCompileFor("typescript", "TypeScript");
}

export function runGeneratedTypeScriptZodCompile() {
  runGeneratedTypeScriptCompileFor("typescript-zod", "TypeScript Zod");
}

/**
 * Type-check the SHIPPED library (models, context, transport, optional zod)
 * under a web-oriented profile: no `@types/node`, the DOM lib instead, and
 * bundler resolution. Without Node's ambient types, any leak of `process`,
 * `Buffer`, `require`, `module`, `__dirname`, or a Node-typed API surfaces as a
 * hard type error — including type-level leaks (e.g. a field typed `Buffer`)
 * that the source-text runtime-neutrality scan cannot see. The `tests/` subtree
 * and consumer-authored `vector-adapters.ts` legitimately run under Node and are
 * excluded, mirroring the runtime-neutrality guard.
 */
export function runGeneratedTypeScriptWebCompileFor(targetDir, label) {
  const sourceDir = path.join(generatedRoot, targetDir);
  const sourceFiles = walkFiles(
    sourceDir,
    (file) =>
      file.endsWith(".ts") &&
      !file.endsWith(".d.ts") &&
      !file.includes(`${path.sep}tests${path.sep}`) &&
      !file.includes(`${path.sep}.typra-conformance${path.sep}`) &&
      !file.includes(`${path.sep}.typra-tests${path.sep}`) &&
      path.basename(file) !== "vector-adapters.ts",
  );

  if (sourceFiles.length === 0) {
    fail(`No generated ${label} library files found for the web compile.`);
    return;
  }
  const tscCli = findTypeScriptCli(packageRoot);
  if (!tscCli) return;

  const configPath = path.join(sourceDir, "tsconfig.web.validate.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        compilerOptions: {
          ...WEB_COMPILE_COMPILER_OPTIONS,
        },
        files: sourceFiles.map((file) => path.resolve(file)),
      },
      null,
      2,
    ),
  );

  try {
    execFileSync(process.execPath, [tscCli, "-p", configPath], {
      cwd: packageRoot,
      stdio: "pipe",
    });
  } catch (error) {
    const output =
      `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(
      `Generated ${label} library does not type-check for the web (no @types/node, DOM lib).\n` +
        `A Node-only global or type leaked into the shipped library; route the host ` +
        `capability through an injected/centralized seam instead.\n${output || error.message}`,
    );
  } finally {
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
  }
}

export function runGeneratedTypeScriptWebCompile() {
  runGeneratedTypeScriptWebCompileFor("typescript", "TypeScript");
}

export function runGeneratedTypeScriptZodWebCompile() {
  runGeneratedTypeScriptWebCompileFor("typescript-zod", "TypeScript Zod");
}

/**
 * Prove the SHIPPED library actually LOADS and RUNS off Node, not merely that it
 * type-checks: emit it to ESM, then execute a real YAML round-trip under ESM
 * resolution hooks that force browser export conditions (dropping Node's always-on
 * `node` condition so a dep like `yaml` resolves its browser build) and reject any
 * Node builtin reached from the generated graph. A Node-only dependency or a
 * `require()`/builtin the static scan and type-check both miss surfaces here as a
 * hard runtime failure. The `tests/` subtree and consumer-authored
 * `vector-adapters.ts` legitimately run under Node and are excluded.
 */
export function runTypeScriptWebRuntimeSmokeFor(targetDir, label) {
  const sourceDir = path.join(generatedRoot, targetDir);
  const sourceFiles = walkFiles(
    sourceDir,
    (file) =>
      file.endsWith(".ts") &&
      !file.endsWith(".d.ts") &&
      !file.includes(`${path.sep}tests${path.sep}`) &&
      !file.includes(`${path.sep}.typra-conformance${path.sep}`) &&
      !file.includes(`${path.sep}.typra-tests${path.sep}`) &&
      !file.includes(`${path.sep}.typra-web${path.sep}`) &&
      path.basename(file) !== "vector-adapters.ts",
  );

  if (sourceFiles.length === 0) {
    fail(`No generated ${label} library files found for the web runtime smoke.`);
    return;
  }
  const tscCli = findTypeScriptCli(packageRoot);
  if (!tscCli) return;

  const outDir = path.join(sourceDir, ".typra-web");
  const configPath = path.join(sourceDir, "tsconfig.web-smoke.json");
  const runnerPath = path.join(outDir, "web-smoke.validate.mjs");
  const registerUrl = pathToFileURL(
    path.join(packageRoot, "scripts", "fixtures", "web-conditions-register.mjs"),
  ).href;

  writeFileSync(
    configPath,
    JSON.stringify(
      {
        compilerOptions: {
          ...WEB_COMPILE_COMPILER_OPTIONS,
          noEmit: false,
          declaration: false,
          outDir,
          rootDir: sourceDir,
        },
        files: sourceFiles.map((file) => path.resolve(file)),
      },
      null,
      2,
    ),
  );

  try {
    // Emit the shipped library to ESM. tsc preserves the emitter's extensionless
    // specifiers under module ESNext; the loader re-adds `.js` at resolve time.
    execFileSync(process.execPath, [tscCli, "-p", configPath], {
      cwd: packageRoot,
      stdio: "pipe",
    });
    writeFileSync(
      path.join(outDir, "package.json"),
      JSON.stringify({ type: "module" }, null, 2),
    );
    writeFileSync(
      runnerPath,
      [
        'import { FixtureRoot } from "./index.js";',
        `const root = FixtureRoot.load(JSON.parse(${fixtureRootSampleJsonLiteral}));`,
        // toYaml -> yaml.stringify and fromYaml -> yaml.parse force the `yaml`
        // dependency (the only external one) to load under browser conditions,
        // and the round-trip exercises the whole model graph end to end.
        "const yamlText = root.toYaml();",
        "const reloaded = FixtureRoot.fromYaml(yamlText);",
        "if (JSON.stringify(reloaded.save()) !== JSON.stringify(root.save())) {",
        '  throw new Error("web runtime YAML round-trip did not preserve the model");',
        "}",
        'process.stdout.write("WEB_SMOKE_OK");',
        "",
      ].join("\n"),
    );

    let output = "";
    try {
      output = execFileSync(
        process.execPath,
        ["--import", registerUrl, runnerPath],
        {
          cwd: outDir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            TYPRA_WEB_GENERATED_URL: pathToFileURL(outDir + path.sep).href,
          },
        },
      );
    } catch (error) {
      const detail =
        `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
      fail(
        `Generated ${label} library failed to load and run on the web ` +
          `(browser export conditions, no Node builtins).\n` +
          `A Node-only dependency or builtin leaked into the shipped library; ` +
          `route the host capability through an injected/centralized seam instead.\n${detail || error.message}`,
      );
      return;
    }
    if (!output.includes("WEB_SMOKE_OK")) {
      fail(
        `Generated ${label} web runtime smoke did not report success. Output:\n${output}`,
      );
    }
  } catch (error) {
    const detail =
      `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(
      `Generated ${label} library failed to compile for the web runtime smoke:\n${detail || error.message}`,
    );
  } finally {
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
    if (existsSync(outDir)) {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
}

export function runTypeScriptWebRuntimeSmoke() {
  runTypeScriptWebRuntimeSmokeFor("typescript", "TypeScript");
}

export function runTypeScriptZodWebRuntimeSmoke() {
  runTypeScriptWebRuntimeSmokeFor("typescript-zod", "TypeScript Zod");
}

export function runTypeScriptGeneratedTests() {
  const sourceDir = path.join(generatedRoot, "typescript");
  const sourceFiles = walkFiles(
    sourceDir,
    (file) =>
      file.endsWith(".ts") &&
      !file.includes(`${path.sep}.typra-tests${path.sep}`),
  );
  const testFiles = sourceFiles.filter(
    (file) =>
      file.includes(`${path.sep}tests${path.sep}`) && file.endsWith(".test.ts"),
  );
  if (testFiles.length === 0) {
    fail("No generated TypeScript tests found to run.");
    return;
  }
  const tscCli = findTypeScriptCli(packageRoot);
  if (!tscCli) return;

  const runnerPath = path.join(sourceDir, "generated-tests.validate.ts");
  const ambientPath = path.join(sourceDir, "test-globals.validate.d.ts");
  const configPath = path.join(sourceDir, "tsconfig.generated-tests.json");
  const outDir = path.join(sourceDir, ".typra-tests");
  const imports = testFiles.map((file) => {
    const relative = `./${path.relative(sourceDir, file).replace(/\\/g, "/").replace(/\.ts$/, "")}`;
    return `require(${JSON.stringify(relative)});`;
  });
  writeFileSync(
    ambientPath,
    [
      "declare function describe(name: string, fn: () => void): void;",
      "declare function it(name: string, fn: () => void): void;",
      "declare function expect(actual: unknown): {",
      "  toBeDefined(): void;",
      "  toBe(expected: unknown): void;",
      "  toEqual(expected: unknown): void;",
      "  toBeInstanceOf(expected: unknown): void;",
      "};",
      "",
    ].join("\n"),
  );
  writeFileSync(
    runnerPath,
    [
      "const suites: string[] = [];",
      "const failures: string[] = [];",
      "function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }",
      "(globalThis as any).describe = (name: string, fn: () => void) => { suites.push(name); try { fn(); } finally { suites.pop(); } };",
      "(globalThis as any).it = (name: string, fn: () => void) => {",
      "  const fullName = [...suites, name].join(' > ');",
      "  try { fn(); console.log(`PASS ${fullName}`); }",
      "  catch (error) { failures.push(fullName); console.error(`FAIL ${fullName}`); console.error(error); }",
      "};",
      "(globalThis as any).expect = (actual: unknown) => ({",
      "  toBeDefined() { if (actual === undefined || actual === null) throw new Error(`Expected value to be defined, got ${actual}`); },",
      "  toBe(expected: unknown) { if (actual !== expected) throw new Error(`Expected ${String(actual)} to be ${String(expected)}`); },",
      "  toEqual(expected: unknown) { if (!same(actual, expected)) throw new Error(`Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`); },",
      "  toBeInstanceOf(expected: { new (...args: any[]): unknown }) { if (!(actual instanceof expected)) throw new Error(`Expected value to be instance of ${expected.name}`); },",
      "});",
      ...imports,
      "if (failures.length > 0) process.exit(1);",
      "",
    ].join("\n"),
  );
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "commonjs",
          moduleResolution: "node",
          esModuleInterop: true,
          skipLibCheck: true,
          types: ["node"],
          typeRoots: typeScriptTypeRoots(tscCli),
          lib: ["ES2022"],
          outDir,
          rootDir: sourceDir,
        },
        files: [...sourceFiles, ambientPath, runnerPath],
      },
      null,
      2,
    ),
  );

  try {
    execFileSync(process.execPath, [tscCli, "-p", configPath], {
      cwd: packageRoot,
      stdio: "pipe",
    });
    writeFileSync(
      path.join(outDir, "package.json"),
      JSON.stringify({ type: "commonjs" }, null, 2),
    );
    let output = "";
    let crashed = null;
    try {
      output = execFileSync(
        process.execPath,
        [path.join(outDir, "generated-tests.validate.js")],
        { cwd: outDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`;
      crashed = error;
    }
    const failed = new Set(
      [...output.matchAll(/^FAIL\s+(.+)$/gm)].map((match) => match[1]),
    );
    assertKnownTestFailures(
      "typescript",
      failed,
      KNOWN_TEST_FAILURES.typescript,
      {
        crashed,
        output,
        crashMessage: "Generated TypeScript tests failed to compile or run",
      },
    );
  } catch (error) {
    const output =
      `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(
      `Generated TypeScript tests failed to compile or run:\n${output || error.message}`,
    );
  } finally {
    for (const tempPath of [runnerPath, configPath, ambientPath]) {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    }
    if (existsSync(outDir)) {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
}

export function runTypeScriptExecutableConformance() {
  const sourceDir = path.join(generatedRoot, "typescript");
  const sourceFiles = walkFiles(
    sourceDir,
    (file) =>
      file.endsWith(".ts") &&
      !file.includes(`${path.sep}.typra-conformance${path.sep}`) &&
      !file.includes(`${path.sep}tests${path.sep}`),
  );
  if (sourceFiles.length === 0) {
    fail("No generated TypeScript files found for executable conformance.");
    return;
  }
  const tscCli = findTypeScriptCli(packageRoot);
  if (!tscCli) return;

  const runnerPath = path.join(sourceDir, "conformance.validate.ts");
  const configPath = path.join(sourceDir, "tsconfig.conformance.json");
  const outDir = path.join(sourceDir, ".typra-conformance");
  writeFileSync(
    runnerPath,
    [
      'import { FixtureBag, FixtureClaimedVariant, FixtureConnection, FixtureContent, FixtureCustomTool, FixtureIndexedList, FixtureNamedPayloadCollection, FixtureNamedRoot, FixtureReference, FixtureRoot, FixtureTool, FixtureToolbox, FixtureUnclaimedBase, SaveContext, WireOptions } from "./index";',
      "",
      `const propertyCases = JSON.parse(${propertyCorpusJsonLiteral}) as Array<{ id: string; seed: string; caseId: string; input: Record<string, unknown> }>;`,
      `const root = FixtureRoot.load(JSON.parse(${fixtureRootSampleJsonLiteral}));`,
      `const imageContent = FixtureContent.load(${JSON.stringify(imageContentSample)});`,
      'const knownContent = FixtureContent.load({ kind: "text", value: "hello" }).save();',
      'if (knownContent.kind !== "text" || knownContent.value !== "hello") throw new Error("closed discriminator known value did not round-trip");',
      'for (const kind of ["video", "Text"]) {',
      "  try {",
      '    FixtureContent.load({ kind, value: "hello" });',
      "    throw new Error(`closed discriminator unexpectedly accepted ${kind}`);",
      "  } catch (error) {",
      "    const message = String(error);",
      '    if (!message.includes("kind") || !message.includes(kind)) throw error;',
      "  }",
      "}",
      'const unknownConnectionInput = { kind: "future-auth", name: "future", config: { nested: [1, null, { enabled: true }] }, nullable: null };',
      "const unknownConnection = FixtureConnection.load(unknownConnectionInput);",
      "unknownConnectionInput.config.nested[0] = 999;",
      'unknownConnection.kind = "future-auth-mutated";',
      "const unknownConnectionSaved = unknownConnection.save();",
      'if (unknownConnectionSaved.kind !== "future-auth-mutated" || unknownConnectionSaved.name !== "future" || !("nullable" in unknownConnectionSaved) || unknownConnectionSaved.nullable !== null) throw new Error("unknown connection modeled/null payload changed");',
      'if ((unknownConnectionSaved.config as { nested: unknown[] }).nested[0] !== 1) throw new Error("unknown connection raw payload aliased load input");',
      "(unknownConnectionSaved.config as { nested: unknown[] }).nested[0] = 777;",
      "const unknownConnectionSavedAgain = unknownConnection.save();",
      'if ((unknownConnectionSavedAgain.config as { nested: unknown[] }).nested[0] !== 1) throw new Error("unknown connection raw payload aliased save output");',
      "const unknownConnectionReloaded = FixtureConnection.load(JSON.parse(JSON.stringify(unknownConnectionSavedAgain))).save();",
      'if (JSON.stringify(unknownConnectionReloaded) !== JSON.stringify(unknownConnectionSavedAgain)) throw new Error("unknown connection payload did not survive load-save-reload");',
      'const caseCollisionInput = { kind: "Custom", name: "case-sensitive-unknown", payload: { mode: "future" } };',
      "const caseCollision = FixtureConnection.load(caseCollisionInput);",
      "const caseCollisionSaved = caseCollision.save();",
      'if (caseCollision.constructor !== FixtureConnection || caseCollisionSaved.kind !== "Custom" || caseCollisionSaved.name !== "case-sensitive-unknown" || (caseCollisionSaved.payload as { mode: string }).mode !== "future" || Object.keys(caseCollisionSaved).length !== 3) throw new Error("wrong-case connection discriminator did not remain unknown");',
      'const knownConnection = FixtureConnection.load({ kind: "custom", name: "known", endpoint: "https://example.test" });',
      'if (knownConnection.constructor === FixtureConnection || knownConnection.save().endpoint !== "https://example.test") throw new Error("known connection dispatch regressed");',
      'const unclaimed = FixtureUnclaimedBase.load({ kind: "plain", label: "leftover" });',
      'if (unclaimed.constructor !== FixtureUnclaimedBase || unclaimed.kind !== "plain" || unclaimed.label !== "leftover") throw new Error("unclaimed closed discriminator value did not load as the base type");',
      'const claimed = FixtureUnclaimedBase.load({ kind: "managed", label: "known", resourceId: "res-1" });',
      'if (!(claimed instanceof FixtureClaimedVariant) || claimed.save().resourceId !== "res-1") throw new Error("claimed discriminator value stopped dispatching to its subtype");',
      'for (const invalidConnectionInput of [{}, { kind: "" }, { kind: null }, { kind: 42 }]) {',
      "  let rejected = false;",
      "  try {",
      "    FixtureConnection.load(invalidConnectionInput as any);",
      "  } catch (error) {",
      "    rejected = true;",
      "    const message = String(error);",
      '    if (!message.includes("kind") && !message.includes("discriminator")) throw error;',
      "  }",
      '  if (!rejected) throw new Error("invalid FixtureConnection discriminator was accepted");',
      "}",
      'const wildcardTool = FixtureTool.load({ kind: "vendor", name: "vendor", description: "vendor description", connection: { kind: "future-auth", name: "future" }, config: { enabled: true } });',
      'if (!(wildcardTool instanceof FixtureCustomTool)) throw new Error("declared wildcard subtype did not own unknown tool kind");',
      "const wildcardToolSaved = wildcardTool.save();",
      'if (wildcardToolSaved.kind !== "vendor" || wildcardToolSaved.name !== "vendor" || (wildcardToolSaved.config as { enabled: boolean }).enabled !== true) throw new Error("wildcard tool payload changed");',
      'if (!(FixtureTool.load(wildcardToolSaved) instanceof FixtureCustomTool)) throw new Error("wildcard tool did not survive reload");',
      "try {",
      '  FixtureToolbox.load({ tools: { custom: { kind: "vendor" } }, inheritedMapBindingTool: { kind: "function", name: "map", command: "run" }, inheritedListBindingTool: { kind: "function", name: "list", command: "run" } } as any);',
      '  throw new Error("missing required CustomTool.connection was accepted");',
      "} catch (error) {",
      "  const diagnostic = String(error);",
      '  if (!diagnostic.includes("tools.custom.connection") || !diagnostic.includes("missing required field")) throw error;',
      "}",
      "try {",
      '  FixtureIndexedList.load({ entries: [{ label: "first", detail: { code: "ok" } }, { label: "second" }] } as any);',
      '  throw new Error("missing required field inside an array element was accepted");',
      "} catch (error) {",
      "  const diagnostic = String(error);",
      '  if (!diagnostic.includes("entries[1].detail")) throw new Error("array element diagnostic lost the element index: " + diagnostic);',
      "}",
      `const wire = WireOptions.load(${JSON.stringify(wireOptionsSample)});`,
      'const reference = FixtureReference.load("ref-coerced" as any);',
      'const uniqueNamed = FixtureNamedPayloadCollection.load({ items: [{ name: "alpha", payload: { nested: [1, null] } }, { name: "beta", payload: "second" }] });',
      "const uniqueSaved = uniqueNamed.save();",
      'if (Array.isArray(uniqueSaved.items) || Object.keys(uniqueSaved.items as object).join(",") !== "alpha,beta") throw new Error("unique named collection did not save as object");',
      'const lossyNamed = FixtureNamedPayloadCollection.load({ items: [{ payload: { nested: [1, null] } }, { name: "", payload: "second" }] });',
      "const lossySaved = lossyNamed.save();",
      'if (!Array.isArray(lossySaved.items) || lossySaved.items.length !== 2 || "name" in lossySaved.items[1]) throw new Error("unnamed collection did not preserve whole-array fallback");',
      'const duplicateSaved = FixtureNamedPayloadCollection.load({ items: [{ name: "dup", payload: 1 }, { name: "dup", payload: 2 }] }).save();',
      'if (!Array.isArray(duplicateSaved.items) || duplicateSaved.items.length !== 2) throw new Error("duplicate named collection lost entries");',
      'if (!Array.isArray(uniqueNamed.save(new SaveContext({ collectionFormat: "array" })).items)) throw new Error("explicit array format was ignored");',
      'try { FixtureNamedRoot.load({ inputs: { profile: { properties: { arrayEntry: [] } } } }); throw new Error("array-valued named entry was accepted"); } catch (error) { const message = String(error); if (!message.includes("inputs.profile.properties.arrayEntry") || !message.includes("array")) throw error; }',
      'const bag = FixtureBag.load({ items: { alpha: { note: "first" } }, secondItems: { beta: "second" } });',
      'if (bag.items.length !== 1 || bag.items[0].name !== "alpha") throw new Error("named object collection must load into an ordered list");',
      'if (bag.secondItems[0].note !== "second") throw new Error("named scalar shorthand must load into the primary field");',
      "const objectBag = bag.save();",
      'if ((objectBag.items as any).alpha !== "first") throw new Error("default object save must use shorthand");',
      "const expandedBag = bag.save(new SaveContext({ useShorthand: false }));",
      'if (typeof (expandedBag.items as any).alpha !== "object") throw new Error("useShorthand=false must preserve the item object");',
      "console.log(JSON.stringify({",
      "  root: root.save(),",
      "  propertyCases: propertyCases.map((entry) => ({ id: entry.id, seed: entry.seed, caseId: entry.caseId, root: FixtureRoot.load(entry.input).save() })),",
      "  imageContent: imageContent.save(),",
      '  openai: wire.toWire("openai"),',
      '  openaiRoundTrip: WireOptions.fromWire("openai", wire.toWire("openai")).toWire("openai"),',
      '  anthropic: wire.toWire("anthropic"),',
      '  unmapped: wire.toWire("unmapped-provider"),',
      '  emptyProvider: wire.toWire(""),',
      "  reference: reference.save(),",
      "}));",
      "",
    ].join("\n"),
  );
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "commonjs",
          moduleResolution: "node",
          esModuleInterop: true,
          skipLibCheck: true,
          types: ["node"],
          typeRoots: typeScriptTypeRoots(tscCli),
          lib: ["ES2022"],
          outDir,
          rootDir: sourceDir,
        },
        files: [...sourceFiles, runnerPath],
      },
      null,
      2,
    ),
  );

  try {
    execFileSync(process.execPath, [tscCli, "-p", configPath], {
      cwd: packageRoot,
      stdio: "pipe",
    });
    writeFileSync(
      path.join(outDir, "package.json"),
      JSON.stringify({ type: "commonjs" }, null, 2),
    );
    const output = execFileSync(
      process.execPath,
      [path.join(outDir, "conformance.validate.js")],
      { cwd: outDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    assertConformanceResult("typescript", output);
  } catch (error) {
    const output =
      `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(
      `Generated TypeScript executable conformance failed:\n${output || error.message}`,
    );
  } finally {
    for (const tempPath of [runnerPath, configPath]) {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    }
    if (existsSync(outDir)) {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
}

export function runTypeScriptZodExecutableConformance() {
  const sourceDir = path.join(generatedRoot, "typescript-zod");
  const sourceFiles = walkFiles(
    sourceDir,
    (file) =>
      file.endsWith(".ts") &&
      !file.includes(`${path.sep}.typra-conformance${path.sep}`) &&
      !file.includes(`${path.sep}tests${path.sep}`),
  );
  if (sourceFiles.length === 0) {
    fail("No generated TypeScript Zod files found for executable conformance.");
    return;
  }
  const tscCli = findTypeScriptCli(packageRoot);
  if (!tscCli) return;

  const runnerPath = path.join(sourceDir, "conformance.validate.ts");
  const configPath = path.join(sourceDir, "tsconfig.conformance.json");
  const outDir = path.join(sourceDir, ".typra-conformance");
  writeFileSync(
    runnerPath,
    [
      'import { FixtureConnection, FixtureContent, FixtureRoot, FixtureToolbox, WireOptions } from "./index";',
      "",
      "function stable(value: unknown): string {",
      "  if (Array.isArray(value)) return JSON.stringify(value.map(item => JSON.parse(stable(item))));",
      '  if (value && typeof value === "object") {',
      "    const result: Record<string, unknown> = {};",
      "    for (const key of Object.keys(value as Record<string, unknown>).sort()) result[key] = (value as Record<string, unknown>)[key];",
      "    for (const key of Object.keys(result)) result[key] = JSON.parse(stable(result[key]));",
      "    return JSON.stringify(result);",
      "  }",
      "  return JSON.stringify(value);",
      "}",
      "function assertSame(label: string, actual: unknown, expected: unknown): void {",
      "  const actualJson = stable(actual);",
      "  const expectedJson = stable(expected);",
      "  if (actualJson !== expectedJson) throw new Error(`${label} diverged\\nactual=${actualJson}\\nexpected=${expectedJson}`);",
      "}",
      "function assertSchemaAgrees<T extends { save(): Record<string, unknown> }>(label: string, model: { load(data: Record<string, unknown>): T; schema: { parse(data: unknown): Record<string, unknown> } }, input: Record<string, unknown>): void {",
      "  const expected = model.load(input).save();",
      "  const actual = model.schema.parse(input);",
      "  assertSame(label, actual, expected);",
      "}",
      `assertSchemaAgrees("FixtureRoot", FixtureRoot, JSON.parse(${fixtureRootSampleJsonLiteral}));`,
      `assertSchemaAgrees("FixtureContent", FixtureContent, ${JSON.stringify(imageContentSample)});`,
      'assertSchemaAgrees("WireOptions", WireOptions, { maxOutputTokens: 256, temperature: 0.7 });',
      'assertSchemaAgrees("FixtureConnection open unknown", FixtureConnection, { kind: "future-auth", name: "future", config: { nested: [1, null, { enabled: true }] }, nullable: null });',
      'try { FixtureConnection.schema.parse({ kind: "custom", name: "claimed-known" }); throw new Error("open fallback accepted known custom connection without endpoint"); } catch (error) { const message = String(error); if (!message.includes("endpoint") && !message.includes("concrete schema")) throw error; }',
      'try { FixtureContent.schema.parse({ kind: "video", value: "hello" }); throw new Error("closed discriminator Zod schema accepted an unknown content kind"); } catch (error) { const message = String(error); if (!message.includes("video") && !message.includes("discriminator")) throw error; }',
      'try { FixtureToolbox.schema.parse({ tools: { custom: { kind: "vendor" } }, inheritedMapBindingTool: { kind: "function", name: "map", command: "run" }, inheritedListBindingTool: { kind: "function", name: "list", command: "run" } } as any); throw new Error("Zod schema accepted missing required CustomTool.connection"); } catch (error) { const message = String(error); if (!message.includes("tools.custom.connection") || !message.includes("missing required field")) throw error; }',
      "console.log(JSON.stringify({ ok: true }));",
      "",
    ].join("\n"),
  );
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "commonjs",
          moduleResolution: "node",
          esModuleInterop: true,
          skipLibCheck: true,
          types: ["node"],
          typeRoots: typeScriptTypeRoots(tscCli),
          lib: ["ES2022"],
          outDir,
          rootDir: sourceDir,
        },
        files: [...sourceFiles, runnerPath],
      },
      null,
      2,
    ),
  );

  try {
    execFileSync(process.execPath, [tscCli, "-p", configPath], {
      cwd: packageRoot,
      stdio: "pipe",
    });
    writeFileSync(
      path.join(outDir, "package.json"),
      JSON.stringify({ type: "commonjs" }, null, 2),
    );
    const output = execFileSync(
      process.execPath,
      [path.join(outDir, "conformance.validate.js")],
      { cwd: outDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    const result = JSON.parse(output);
    if (result.ok !== true) {
      fail(
        `Generated TypeScript Zod executable conformance emitted an unexpected result: ${output}`,
      );
    }
  } catch (error) {
    const output =
      `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(
      `Generated TypeScript Zod executable conformance failed:\n${output || error.message}`,
    );
  } finally {
    for (const tempPath of [runnerPath, configPath]) {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    }
    if (existsSync(outDir)) {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
}

export function runTypeScriptVectorConformanceCompile() {
  // Red-first gate for the typed conformance ENTRYPOINT (issue #511 Cat 1,
  // typra#306 Track A). The emitter emits `run<Seam>Conformance(seam)` into the
  // model output-dir as `vector-conformance.ts`; a consumer migrates a plain seam
  // off the stringly `vector-adapters` registry by authoring only a real
  // `implements <Seam>` and one typed call. This gate proves that path stands
  // ALONE: generate the typed-seam-conformance fixture, EXCLUDE the stringly-rail
  // test tree (the vector-runner + vector-conformance.test that need a
  // hand-authored vector-adapters module), attach the committed typed double,
  // tsc-compile the model + entrypoint + double to JS, and RUN it so the vectors
  // actually execute.
  //
  // Red-first: if the entrypoint is not emitted, `vector-conformance.ts` does not
  // exist and the double's `import { runTransformerConformance }` fails to
  // compile — so this gate fails on `main`.
  const tscCli = findTypeScriptCli(packageRoot);
  if (!tscCli) return;

  const fixtureDir = path.join(
    packageRoot,
    "fixtures",
    "features",
    "typed-seam-conformance",
  );
  // Generate INSIDE the package tree so Node/tsc module resolution climbs to the
  // repo-root node_modules (the emitted model's `context.ts` imports `yaml`).
  const outRoot = mkdtempSync(path.join(packageRoot, ".typra-ts-typedseam-"));
  try {
    execFileSync(
      process.execPath,
      [
        path.join(packageRoot, "dist", "src", "cli.js"),
        "--output",
        outRoot,
        "--targets",
        "typescript",
        "--spec",
        path.join(fixtureDir, "main.tsp"),
        "--root-object",
        "Typra.Fixtures.Features.TypedSeamConformance.Root",
        "--deterministic",
        "--no-format",
      ],
      { cwd: packageRoot, stdio: "pipe" },
    );
    const sourceDir = path.join(outRoot, "typescript");
    if (!existsSync(sourceDir)) {
      fail("TypeScript typed-seam-conformance gate: no typescript output generated.");
      return;
    }
    if (!existsSync(path.join(sourceDir, "vector-conformance.ts"))) {
      fail(
        "TypeScript typed-seam-conformance gate: emitter did not emit " +
          "vector-conformance.ts (the typed conformance entrypoint). The committed " +
          "double cannot import runTransformerConformance — this is the red-first " +
          "signal.",
      );
      return;
    }
    // Attach the committed typed double at the model root so its relative imports
    // (`./index`, `./vector-conformance`) resolve.
    const doublePath = path.join(sourceDir, "conformance.run.ts");
    writeFileSync(
      doublePath,
      readFileSync(
        path.join(
          fixtureDir,
          "vector-adapters",
          "typescript",
          "conformance.run.ts",
        ),
        "utf8",
      ),
    );
    // The typed entrypoint stands alone: exclude the stringly rail (the tests/
    // subtree + any *.test.ts) that would otherwise need a hand-authored
    // vector-adapters module and test-runner ambient globals to compile.
    const sourceFiles = walkFiles(
      sourceDir,
      (file) =>
        file.endsWith(".ts") &&
        !file.endsWith(".test.ts") &&
        !file.includes(`${path.sep}tests${path.sep}`) &&
        !file.includes(`${path.sep}.typra-conformance${path.sep}`),
    );
    const configPath = path.join(sourceDir, "tsconfig.conformance.json");
    const compiledDir = path.join(sourceDir, ".typra-conformance");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "commonjs",
            moduleResolution: "node",
            esModuleInterop: true,
            skipLibCheck: true,
            strict: true,
            types: ["node"],
            typeRoots: typeScriptTypeRoots(tscCli),
            lib: ["ES2022"],
            outDir: compiledDir,
            rootDir: sourceDir,
          },
          files: sourceFiles,
        },
        null,
        2,
      ),
    );
    try {
      execFileSync(process.execPath, [tscCli, "-p", configPath], {
        cwd: packageRoot,
        stdio: "pipe",
      });
      writeFileSync(
        path.join(compiledDir, "package.json"),
        JSON.stringify({ type: "commonjs" }, null, 2),
      );
      const output = execFileSync(
        process.execPath,
        [path.join(compiledDir, "conformance.run.js")],
        { cwd: compiledDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
      if (!output.includes("TYPED_CONFORMANCE_OK")) {
        fail(
          `TypeScript typed-seam-conformance run did not report success:\n${output}`,
        );
      }
    } catch (error) {
      const output =
        `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
      fail(
        `TypeScript typed-seam-conformance compile/run gate failed:\n${output || error.message}`,
      );
    }
  } finally {
    if (existsSync(outRoot)) {
      rmSync(outRoot, { recursive: true, force: true });
    }
  }
}
