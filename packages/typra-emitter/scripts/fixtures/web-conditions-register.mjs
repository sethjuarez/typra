// Registers the web-conditions ESM resolution hooks. Used via
// `node --import <this file> runner.mjs`. The generated output directory whose
// imports should be policed is passed through TYPRA_WEB_GENERATED_URL so the
// same static entry point works for any run.
import { register } from "node:module";

register("./web-conditions-loader.mjs", {
  parentURL: import.meta.url,
  data: { generatedDirUrl: process.env.TYPRA_WEB_GENERATED_URL ?? null },
});
