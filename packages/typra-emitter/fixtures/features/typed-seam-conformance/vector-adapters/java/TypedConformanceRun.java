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

  public static void main(String[] args) throws Exception {
    VectorConformance.runTransformerConformance(new TransformerImpl());
    System.out.println("PASS TransformerTypedConformance");
  }
}
