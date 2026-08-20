// Reference adapters for the integration fixture's @vector suite. Included by
// the generated conformance suite via #[path]. Copied into each Rust target's
// tests/ dir by validate-fixtures. See fixtures/integration/vector-adapters.
#![allow(dead_code, unused_variables, clippy::all)]

use serde_json::{json, Value};
use std::collections::HashMap;

pub struct Context {
    pub contract: String,
    pub operation: String,
    pub vector: Value,
    pub provider: Option<String>,
    pub target_api: Option<String>,
    pub doubles: Value,
    pub base_dir: String,
}

pub struct VectorError {
    pub message: String,
    pub payload: Option<Value>,
}

pub struct Adapter {
    pub invoke: fn(&Value, &Context) -> Result<Value, VectorError>,
    pub normalize: Option<fn(&Value, &Context) -> Value>,
}

fn authorize_invoke(_input: &Value, _ctx: &Context) -> Result<Value, VectorError> {
    Ok(json!({ "approved": true }))
}

fn format_invoke(input: &Value, _ctx: &Context) -> Result<Value, VectorError> {
    Ok(input.get("messages").cloned().unwrap_or(Value::Null))
}

pub fn doubles() -> Value {
    json!({})
}

pub fn waivers() -> HashMap<&'static str, &'static str> {
    HashMap::new()
}

pub fn adapters() -> HashMap<&'static str, Adapter> {
    let mut map = HashMap::new();
    map.insert(
        "CanonicalEnginePort.authorize",
        Adapter { invoke: authorize_invoke, normalize: None },
    );
    map.insert(
        "CanonicalEnginePort.format",
        Adapter { invoke: format_invoke, normalize: None },
    );
    map
}
