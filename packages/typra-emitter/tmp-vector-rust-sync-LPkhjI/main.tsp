import "@typra/emitter";

namespace Typra.SyncProof;

model Root {
  id: string;
}

const TagVectors = #[
  #{ name: "basic", input: #{ label: "x" }, expected: "TAG:x" }
];

const NoteVectors = #[
  #{ name: "basic", input: #{ text: "hi" }, expected: "hi!" }
];

interface Tag {
  @sync
  @vector(TagVectors)
  tag(label: string): string;
}

interface Note {
  @vector(NoteVectors)
  note(text: string): string;
}
