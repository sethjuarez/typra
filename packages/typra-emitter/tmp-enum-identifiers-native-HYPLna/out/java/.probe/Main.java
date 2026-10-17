public class Main {
  public static void main(String[] args) {
    check("{\"odd\":\"kebab-case\",\"pair\":\"UPPER\",\"empty\":\"a\"}", typra.fixtures.features.stringenumidentifiers.Root.fromJson("{\"odd\":\"kebab-case\",\"pair\":\"UPPER\",\"empty\":\"a\"}").odd == typra.fixtures.features.stringenumidentifiers.Odd.KEBAB_CASE, "odd", "kebab-case");
    check("{\"odd\":\"with space\",\"pair\":\"UPPER\",\"empty\":\"a\"}", typra.fixtures.features.stringenumidentifiers.Root.fromJson("{\"odd\":\"with space\",\"pair\":\"UPPER\",\"empty\":\"a\"}").odd == typra.fixtures.features.stringenumidentifiers.Odd.WITH_SPACE, "odd", "with space");
    check("{\"odd\":\"1x\",\"pair\":\"UPPER\",\"empty\":\"a\"}", typra.fixtures.features.stringenumidentifiers.Root.fromJson("{\"odd\":\"1x\",\"pair\":\"UPPER\",\"empty\":\"a\"}").odd == typra.fixtures.features.stringenumidentifiers.Odd._1X, "odd", "1x");
    check("{\"odd\":\"dot.ted\",\"pair\":\"UPPER\",\"empty\":\"a\"}", typra.fixtures.features.stringenumidentifiers.Root.fromJson("{\"odd\":\"dot.ted\",\"pair\":\"UPPER\",\"empty\":\"a\"}").odd == typra.fixtures.features.stringenumidentifiers.Odd.DOT_TED, "odd", "dot.ted");
    check("{\"odd\":\"dot ted\",\"pair\":\"UPPER\",\"empty\":\"a\"}", typra.fixtures.features.stringenumidentifiers.Root.fromJson("{\"odd\":\"dot ted\",\"pair\":\"UPPER\",\"empty\":\"a\"}").odd == typra.fixtures.features.stringenumidentifiers.Odd.DOT_TED_2, "odd", "dot ted");
    check("{\"odd\":\"1x\",\"pair\":\"UPPER\",\"empty\":\"a\"}", typra.fixtures.features.stringenumidentifiers.Root.fromJson("{\"odd\":\"1x\",\"pair\":\"UPPER\",\"empty\":\"a\"}").pair == typra.fixtures.features.stringenumidentifiers.CasePair.UPPER, "pair", "UPPER");
    check("{\"odd\":\"1x\",\"pair\":\"upper\",\"empty\":\"a\"}", typra.fixtures.features.stringenumidentifiers.Root.fromJson("{\"odd\":\"1x\",\"pair\":\"upper\",\"empty\":\"a\"}").pair == typra.fixtures.features.stringenumidentifiers.CasePair.UPPER_2, "pair", "upper");
    check("{\"odd\":\"1x\",\"pair\":\"UPPER\",\"empty\":\"\"}", typra.fixtures.features.stringenumidentifiers.Root.fromJson("{\"odd\":\"1x\",\"pair\":\"UPPER\",\"empty\":\"\"}").empty == typra.fixtures.features.stringenumidentifiers.Empty.VALUE, "empty", "");
    check("{\"odd\":\"1x\",\"pair\":\"UPPER\",\"empty\":\"a\"}", typra.fixtures.features.stringenumidentifiers.Root.fromJson("{\"odd\":\"1x\",\"pair\":\"UPPER\",\"empty\":\"a\"}").empty == typra.fixtures.features.stringenumidentifiers.Empty.A, "empty", "a");
    System.out.println("enum-roundtrip-ok");
  }

  static void check(String input, boolean member, String field, String value) {
    if (!member) throw new IllegalStateException("load " + input);
    Object saved = typra.fixtures.features.stringenumidentifiers.Root.fromJson(input).save(null).get(field);
    if (!value.equals(saved)) throw new IllegalStateException("round trip " + input + " => " + saved);
  }
}
