// Committed consumer double for the Category 1 (issue #511) typed vector
// conformance entrypoint. Unlike the stringly VectorRunner rail — which needs a
// hand-authored per-op marshalling adapter — the consumer authors ONLY a real
// typed Transformer impl and one typed call. The emitted
// `VectorConformance.runTransformerConformance(Transformer)` bakes the vectors in
// and, by typing its parameter as the emitted Transformer interface, makes a
// missing op a compile error rather than a runtime skip.
//
// This is a plain `main` runner (the generated Java tests use the same
// static-run / System.exit protocol, not JUnit). It exits non-zero on any
// conformance failure so the compile gate fails red.
package typra.fixtures.features.typedseamconformance;

public final class TypedConformanceRun {
  private TypedConformanceRun() { }

  // The consumer's real seam implementation. Trims its input and rejects the
  // "boom" vector, matching the fixture's baked-in expectations.
  static final class TransformerImpl implements Transformer {
    @Override
    public String transform(String text) {
      if (text != null && text.contains("boom")) {
        throw new IllegalStateException("boom not allowed");
      }
      return text == null ? null : text.trim();
    }
  }

  // A model-in/model-out seam impl: proves the typed entrypoint decodes the Note
  // param via the emitted `Note.load(...)` and serializes the Note result back
  // through `actual.toJson()`. Uppercases the title in place and returns it.
  static final class ReviserImpl implements Reviser {
    @Override
    public Note revise(Note note) {
      note.title = note.title == null ? null : note.title.toUpperCase();
      return note;
    }
  }

  // An array-in/array-out seam impl: proves the typed entrypoint decodes the
  // List<Note> param via per-element `Note.load(...)` and serializes the
  // List<Note> result element-wise through `toJson()`. Reverses the notes, each
  // passing through unchanged.
  static final class CollatorImpl implements Collator {
    @Override
    public java.util.List<Note> collate(java.util.List<Note> notes) {
      java.util.List<Note> reversed = new java.util.ArrayList<>(notes);
      java.util.Collections.reverse(reversed);
      return reversed;
    }
  }

  public static void main(String[] args) throws Exception {
    VectorConformance.runTransformerConformance(new TransformerImpl());
    System.out.println("PASS TransformerTypedConformance");
    VectorConformance.runReviserConformance(new ReviserImpl());
    System.out.println("PASS ReviserTypedConformance");
    VectorConformance.runCollatorConformance(new CollatorImpl());
    System.out.println("PASS CollatorTypedConformance");
  }
}
