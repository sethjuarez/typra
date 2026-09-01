// Committed consumer double for the TypeScript typed @vector conformance
// entrypoint (issue #511 Cat 1, typra#306 Track A). This is the WHOLE authored
// surface a consumer needs to migrate a plain seam off the stringly
// vector-adapters registry: a real `implements Transformer` and one typed call
// to the emitted `runTransformerConformance`. No registry, no string keys, no
// per-op marshalling double.
//
// The `implements Transformer` annotation makes tsc prove every op is
// implemented — drop a method and this file fails to compile. The
// `runTransformerConformance` import resolves only when the emitter emits
// `vector-conformance.ts`; on `main` it does not exist, so this file fails to
// compile (the red-first signal).
import type { Transformer } from "./index";
import { runTransformerConformance } from "./vector-conformance";

class TransformerImpl implements Transformer {
  async transform(text: string): Promise<string> {
    if (text === "boom") {
      throw new Error("boom not allowed");
    }
    return text.trim();
  }
}

async function main(): Promise<void> {
  await runTransformerConformance(new TransformerImpl());
  console.log("TYPED_CONFORMANCE_OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
