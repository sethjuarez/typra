package typrafixturesfeaturesstringenumidentifiers

import (
	"encoding/json"
	"reflect"
	"testing"
)

func check(t *testing.T, input string, member func(Root) bool) {
	loaded, err := RootFromJSON(input)
	if err != nil || !member(loaded) {
		t.Fatalf("load %s: %+v %v", input, loaded, err)
	}
	saved, err := loaded.ToJSON()
	if err != nil {
		t.Fatal(err)
	}
	var want, got map[string]any
	_ = json.Unmarshal([]byte(input), &want)
	_ = json.Unmarshal([]byte(saved), &got)
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("round trip %s => %s", input, saved)
	}
}

func TestEnumRoundTrip(t *testing.T) {
	check(t, "{\"odd\":\"kebab-case\",\"pair\":\"UPPER\",\"empty\":\"a\"}", func(r Root) bool { return r.Odd == OddKebab_case })
	check(t, "{\"odd\":\"with space\",\"pair\":\"UPPER\",\"empty\":\"a\"}", func(r Root) bool { return r.Odd == OddWith_space })
	check(t, "{\"odd\":\"1x\",\"pair\":\"UPPER\",\"empty\":\"a\"}", func(r Root) bool { return r.Odd == Odd1x })
	check(t, "{\"odd\":\"dot.ted\",\"pair\":\"UPPER\",\"empty\":\"a\"}", func(r Root) bool { return r.Odd == OddDot_ted })
	check(t, "{\"odd\":\"dot ted\",\"pair\":\"UPPER\",\"empty\":\"a\"}", func(r Root) bool { return r.Odd == OddDot_ted_2 })
	check(t, "{\"odd\":\"1x\",\"pair\":\"UPPER\",\"empty\":\"a\"}", func(r Root) bool { return r.Pair == CasePairUPPER })
	check(t, "{\"odd\":\"1x\",\"pair\":\"upper\",\"empty\":\"a\"}", func(r Root) bool { return r.Pair == CasePairUpper })
	check(t, "{\"odd\":\"1x\",\"pair\":\"UPPER\",\"empty\":\"\"}", func(r Root) bool { return r.Empty == EmptyValue })
	check(t, "{\"odd\":\"1x\",\"pair\":\"UPPER\",\"empty\":\"a\"}", func(r Root) bool { return r.Empty == EmptyA })
}
