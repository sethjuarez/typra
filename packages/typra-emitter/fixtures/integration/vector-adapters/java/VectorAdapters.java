// Reference adapters for the integration fixture's @vector suite. Copied into
// each Java target's tests/ dir by validate-fixtures before the generated
// conformance suite runs. See fixtures/integration/vector-adapters.
//
// Serialization-agnostic: the generated harness drives the built-in JSON value
// model (Map/List/String/Number/Boolean/null), so adapters receive and return
// that Object tree — no Jackson required, regardless of the target's
// native-serialization backend.
package typra.fixtures;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import typra.fixtures.VectorConformanceTests.VectorAdapter;
import typra.fixtures.VectorConformanceTests.VectorContext;

public final class VectorAdapters {
  private VectorAdapters() { }

  private static Object authorizeInvoke(Object input, VectorContext ctx) {
    Map<String, Object> result = new LinkedHashMap<>();
    result.put("approved", true);
    return result;
  }

  private static Object formatInvoke(Object input, VectorContext ctx) {
    return input instanceof Map<?, ?> map ? map.get("messages") : null;
  }

  public static Map<String, VectorAdapter> adapters() {
    Map<String, VectorAdapter> m = new HashMap<>();
    m.put("CanonicalEnginePort.authorize", new VectorAdapter(VectorAdapters::authorizeInvoke));
    m.put("CanonicalEnginePort.format", new VectorAdapter(VectorAdapters::formatInvoke));
    return m;
  }

  public static Map<String, String> waivers() {
    return new HashMap<>();
  }

  public static Object doubles() {
    return new LinkedHashMap<String, Object>();
  }
}
