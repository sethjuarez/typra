using System.Text.Json.Nodes;
using Typra.Fixtures.Features.StringEnumIdentifiers;

Check("{\"odd\":\"kebab-case\",\"pair\":\"UPPER\",\"empty\":\"a\"}", r => r.Odd == Odd.Kebab_case, "odd", "kebab-case");
Check("{\"odd\":\"with space\",\"pair\":\"UPPER\",\"empty\":\"a\"}", r => r.Odd == Odd.With_space, "odd", "with space");
Check("{\"odd\":\"1x\",\"pair\":\"UPPER\",\"empty\":\"a\"}", r => r.Odd == Odd.Value1x, "odd", "1x");
Check("{\"odd\":\"dot.ted\",\"pair\":\"UPPER\",\"empty\":\"a\"}", r => r.Odd == Odd.Dot_ted, "odd", "dot.ted");
Check("{\"odd\":\"dot ted\",\"pair\":\"UPPER\",\"empty\":\"a\"}", r => r.Odd == Odd.Dot_ted_2, "odd", "dot ted");
Check("{\"odd\":\"1x\",\"pair\":\"UPPER\",\"empty\":\"a\"}", r => r.Pair == CasePair.UPPER, "pair", "UPPER");
Check("{\"odd\":\"1x\",\"pair\":\"upper\",\"empty\":\"a\"}", r => r.Pair == CasePair.Upper, "pair", "upper");
Check("{\"odd\":\"1x\",\"pair\":\"UPPER\",\"empty\":\"\"}", r => r.Empty == Empty.Value, "empty", "");
Check("{\"odd\":\"1x\",\"pair\":\"UPPER\",\"empty\":\"a\"}", r => r.Empty == Empty.A, "empty", "a");
Console.WriteLine("enum-roundtrip-ok");

static void Check(string input, Func<Root, bool> member, string field, string value)
{
    var loaded = Root.FromJson(input);
    if (!member(loaded)) throw new Exception($"load {input}");
    var saved = JsonNode.Parse(loaded.ToJson())!;
    if (saved[field]!.GetValue<string>() != value)
        throw new Exception($"round trip {input} => {saved.ToJsonString()}");
}
