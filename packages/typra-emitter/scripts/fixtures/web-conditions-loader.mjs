// ESM resolution hooks that make Node resolve a module graph the way a web
// bundler would, so an executable smoke test can prove the shipped library
// actually loads and runs off Node — not merely that it type-checks.
//
// Two web realities are enforced, but ONLY for modules imported by generated
// code (scoped via the importer's URL); the surrounding Node test harness keeps
// its normal builtins:
//   1. Browser dependency resolution. Node always applies the `node` export
//      condition and `--conditions` can only ADD conditions, so a package like
//      `yaml` (whose exports map has `node` -> dist and `default` -> browser)
//      always resolves to its Node build under plain Node. Dropping `node`
//      (and `node-addons`) and adding `browser` here forces the browser entry,
//      exactly as esbuild/webpack `platform: browser` would.
//   2. No Node builtins. The web has no `fs`/`path`/`node:*`; if the shipped
//      library (or a dependency reached under browser conditions) resolves one,
//      that is the coupling this gate exists to catch, so we throw.
//
// tsc emits extensionless relative specifiers (`./context`); a bundler resolves
// them but native ESM does not, so we re-add the `.js` the emitter omitted for
// generated relative imports.
import { isBuiltin } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

let generatedDirUrl = null;

export async function initialize(data) {
  generatedDirUrl = data?.generatedDirUrl ?? null;
}

function importerIsGenerated(parentURL) {
  return Boolean(
    parentURL && generatedDirUrl && parentURL.startsWith(generatedDirUrl),
  );
}

export async function resolve(specifier, context, nextResolve) {
  if (!importerIsGenerated(context.parentURL)) {
    return nextResolve(specifier);
  }

  if (isBuiltin(specifier)) {
    throw new Error(
      `web-runtime smoke: shipped library resolved Node builtin "${specifier}" ` +
        `(imported from ${context.parentURL}). The generated library must not ` +
        `depend on Node builtins so it loads on the web.`,
    );
  }

  // Re-add the extension tsc omitted, scoped to relative imports from generated
  // code, so native ESM can load the emitted files.
  if (specifier.startsWith(".")) {
    const parentPath = fileURLToPath(context.parentURL);
    const resolved = path.resolve(path.dirname(parentPath), specifier);
    for (const candidate of [
      resolved,
      `${resolved}.js`,
      path.join(resolved, "index.js"),
    ]) {
      if (existsSync(candidate) && candidate.endsWith(".js")) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
  }

  const conditions = context.conditions.filter(
    (condition) => condition !== "node" && condition !== "node-addons",
  );
  if (!conditions.includes("browser")) {
    conditions.push("browser");
  }
  return nextResolve(specifier, { ...context, conditions });
}
