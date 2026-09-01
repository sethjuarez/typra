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
import type { Collator, Note, Reviser, Transformer } from "./index";
import {
  runCollatorConformance,
  runReviserConformance,
  runTransformerConformance,
} from "./vector-conformance";

class TransformerImpl implements Transformer {
  async transform(text: string): Promise<string> {
    if (text === "boom") {
      throw new Error("boom not allowed");
    }
    return text.trim();
  }
}

// A model-in / model-out seam: upper-case the note title, pass the body through.
// The emitted entrypoint decodes the `note` param with `JSON.parse(...) as Note`
// and compares the returned `Note` with a `JSON.parse(JSON.stringify(actual))`
// round-trip. Mutate and return the typed input so the result stays a `Note`
// (the closure model is a class; an object literal would miss its methods).
class ReviserImpl implements Reviser {
  async revise(note: Note): Promise<Note> {
    note.title = note.title.toUpperCase();
    return note;
  }
}

// An array-in / array-out seam: reverse the notes, each passing through
// unchanged. The emitted entrypoint decodes the `notes` param with
// `JSON.parse(...) as Note[]` and compares the returned `Note[]` with the same
// `JSON.parse(JSON.stringify(actual))` round-trip — the structural cast and
// compare lift over arrays with no per-element handling.
class CollatorImpl implements Collator {
  async collate(notes: Note[]): Promise<Note[]> {
    return [...notes].reverse();
  }
}

async function main(): Promise<void> {
  await runTransformerConformance(new TransformerImpl());
  await runReviserConformance(new ReviserImpl());
  await runCollatorConformance(new CollatorImpl());
  console.log("TYPED_CONFORMANCE_OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
