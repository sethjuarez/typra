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
}

// A @sync op wired synchronously: a bare `fn`.
fn tag_sync(input: &Value, _ctx: &Context) -> Result<Value, VectorError> {
    let label = input.get("label").and_then(|v| v.as_str()).unwrap_or("");
    Ok(Value::String(format!("TAG:{}", label)))
}

// The same op wired asynchronously — the classification violation under test.
async fn tag_async(input: Value, _ctx: Context) -> Result<Value, VectorError> {
    tokio::task::yield_now().await;
    let label = input.get("label").and_then(|v| v.as_str()).unwrap_or("");
    Ok(Value::String(format!("TAG:{}", label)))
}

// An async-default op wired asynchronously — permissive, must stay green.
async fn note_async(input: Value, _ctx: Context) -> Result<Value, VectorError> {
    tokio::task::yield_now().await;
    let text = input.get("text").and_then(|v| v.as_str()).unwrap_or("");
    Ok(Value::String(format!("{}!", text)))
}

pub fn doubles() -> Value {
    json!({})
}

pub fn waivers() -> HashMap<&'static str, &'static str> {
    HashMap::new()
}

pub fn adapters() -> HashMap<&'static str, Adapter> {
    let mut map = HashMap::new();
    map.insert("Tag.tag", Adapter::sync(tag_sync));
    map.insert("Note.note", Adapter::asynchronous(|input, ctx| note_async(input.clone(), ctx.clone())));
    let _ = tag_async;
    map
}
