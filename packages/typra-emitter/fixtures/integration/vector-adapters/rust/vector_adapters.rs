// Reference adapters for the integration fixture's @vector suite. Included by
// the generated conformance suite via #[path]. Copied into each Rust target's
// tests/ dir by validate-fixtures. See fixtures/integration/vector-adapters.
#![allow(dead_code, unused_variables, clippy::all)]

use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

#[derive(Clone)]
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

// An adapter body returns a plain value (sync) or a future (async). The two are
// unified behind one enum so the generated harness awaits exactly once, on the
// test's current-thread tokio runtime. A synchronous adapter stays a bare `fn`
// with no boxing and no blocking bridge; an async adapter is registered with
// Adapter::asynchronous and owns its inputs inside the async block (the future
// is `'static`, so borrow `&Value`/`&Context` only to clone what it needs).
pub type BoxFuture = Pin<Box<dyn Future<Output = Result<Value, VectorError>>>>;

pub enum Invoke {
    Sync(fn(&Value, &Context) -> Result<Value, VectorError>),
    Async(Box<dyn Fn(&Value, &Context) -> BoxFuture>),
}

pub struct Adapter {
    pub invoke: Invoke,
    pub normalize: Option<fn(&Value, &Context) -> Value>,
}

impl Adapter {
    pub fn sync(invoke: fn(&Value, &Context) -> Result<Value, VectorError>) -> Self {
        Self { invoke: Invoke::Sync(invoke), normalize: None }
    }

    pub fn asynchronous<F, Fut>(invoke: F) -> Self
    where
        F: Fn(&Value, &Context) -> Fut + 'static,
        Fut: Future<Output = Result<Value, VectorError>> + 'static,
    {
        Self {
            invoke: Invoke::Async(Box::new(move |input, ctx| Box::pin(invoke(input, ctx)))),
            normalize: None,
        }
    }

    pub fn with_normalize(mut self, normalize: fn(&Value, &Context) -> Value) -> Self {
        self.normalize = Some(normalize);
        self
    }
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
        Adapter::sync(authorize_invoke),
    );
    map.insert(
        "CanonicalEnginePort.format",
        Adapter::sync(format_invoke),
    );
    map
}
