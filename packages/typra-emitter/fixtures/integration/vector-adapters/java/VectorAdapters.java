// Reference adapters for the integration fixture's @vector suite. Copied into
// the java-jackson target's tests/ dir by validate-fixtures before the
// generated conformance suite runs. See fixtures/integration/vector-adapters.
package typra.fixtures;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import java.util.HashMap;
import java.util.Map;
import typra.fixtures.VectorConformanceTests.VectorAdapter;
import typra.fixtures.VectorConformanceTests.VectorContext;

public final class VectorAdapters {
  private VectorAdapters() { }

  private static final JsonNodeFactory NF = JsonNodeFactory.instance;

  private static JsonNode authorizeInvoke(JsonNode input, VectorContext ctx) {
    return NF.objectNode().put("approved", true);
  }

  private static JsonNode formatInvoke(JsonNode input, VectorContext ctx) {
    return input.path("messages");
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

  public static JsonNode doubles() {
    return NF.objectNode();
  }
}
