use probe::model::fixtures::features::field_identifiers::Root;
use probe::model::{LoadContext, SaveContext};

#[test]
fn encoded_names_round_trip() {
    let input: serde_json::Value = serde_json::from_str(r#"{"class":"v-class","import":"v-import","self":"v-self","super":"v-super","crate":"v-crate","x-trace-id":"v-x-trace-id","2fa":"v-2fa","def":"v-def","lambda":"v-lambda","yield":"v-yield","pass":"v-pass","from":"v-from","async":"v-async","await":"v-await","func":"v-func","range":"v-range","chan":"v-chan","go":"v-go","select":"v-select","default":"v-default","where":"v-where","protocol":"v-protocol","struct":"v-struct","match":"v-match","loop":"v-loop","mut":"v-mut","ref":"v-ref","move":"v-move","fn":"v-fn","event":"v-event","object":"v-object","string":"v-string","delete":"v-delete","new":"v-new","this":"v-this","let":"v-let","in":"v-in","type":"v-type","var":"v-var","static":"v-static","return":"v-return","true":"v-true","false":"v-false","nil":"v-nil","null":"v-null","None":"v-None"}"#).unwrap();
    let root = Root::load_from_value(&input, &LoadContext::default());
    assert_eq!(root.self_.as_deref(), Some("v-self"));
    assert_eq!(root.r#yield.as_deref(), Some("v-yield"));
    assert_eq!(root.to_value(&SaveContext::default()), input);
}
