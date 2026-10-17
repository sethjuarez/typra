using System.Text.Json.Nodes;
using Typra.Fixtures.Features.FieldIdentifiers;

var input = "{\"class\":\"v-class\",\"import\":\"v-import\",\"self\":\"v-self\",\"super\":\"v-super\",\"crate\":\"v-crate\",\"x-trace-id\":\"v-x-trace-id\",\"2fa\":\"v-2fa\",\"def\":\"v-def\",\"lambda\":\"v-lambda\",\"yield\":\"v-yield\",\"pass\":\"v-pass\",\"from\":\"v-from\",\"async\":\"v-async\",\"await\":\"v-await\",\"func\":\"v-func\",\"range\":\"v-range\",\"chan\":\"v-chan\",\"go\":\"v-go\",\"select\":\"v-select\",\"default\":\"v-default\",\"where\":\"v-where\",\"protocol\":\"v-protocol\",\"struct\":\"v-struct\",\"match\":\"v-match\",\"loop\":\"v-loop\",\"mut\":\"v-mut\",\"ref\":\"v-ref\",\"move\":\"v-move\",\"fn\":\"v-fn\",\"event\":\"v-event\",\"object\":\"v-object\",\"string\":\"v-string\",\"delete\":\"v-delete\",\"new\":\"v-new\",\"this\":\"v-this\",\"let\":\"v-let\",\"in\":\"v-in\",\"type\":\"v-type\",\"var\":\"v-var\",\"static\":\"v-static\",\"return\":\"v-return\",\"true\":\"v-true\",\"false\":\"v-false\",\"nil\":\"v-nil\",\"null\":\"v-null\",\"None\":\"v-None\"}";
var saved = Root.FromJson(input).ToJson();
if (!JsonNode.DeepEquals(JsonNode.Parse(input), JsonNode.Parse(saved)))
    throw new Exception($"round trip => {saved}");
Console.WriteLine("cs-roundtrip-ok");
