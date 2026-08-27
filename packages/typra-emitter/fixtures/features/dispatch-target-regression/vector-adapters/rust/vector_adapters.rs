// Consumer-authored provider doubles for the dispatch-target-regression seams.
//
// COMPILE-ONLY: these satisfy the emitted provider traits so the regression
// compile gate (`cargo build --tests`) compiles the generated seam conformance
// tests. The class of target bug this fixture guards — accessor drift on
// coerce-union + optional fields lowering to `serde_json::Value` (E0599/E0609),
// missing imports, invalid raw-string literals — is always a COMPILE error, so a
// build gate catches it. Behavioral correctness is covered by the emitter unit
// tests and downstream runtime conformance, so the double bodies are inert.
#![allow(dead_code, unused_variables, clippy::all)]

use crate::model::processor_resolver::ProcessorProvider;
use crate::model::renderer_resolver::RendererProvider;
use crate::model::{Agent, Processor, Renderer};

struct StubRenderer;

#[async_trait::async_trait]
impl Renderer for StubRenderer {
    async fn render(
        &self,
        agent: &Agent,
        template: &String,
        inputs: &serde_json::Value,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        Ok(String::new())
    }
}

pub struct StubRendererProvider {
    inner: StubRenderer,
}

impl RendererProvider for StubRendererProvider {
    fn jinja2(&self) -> Option<&dyn Renderer> {
        Some(&self.inner)
    }
    fn mustache(&self) -> Option<&dyn Renderer> {
        Some(&self.inner)
    }
    fn custom(&self) -> Option<&dyn Renderer> {
        Some(&self.inner)
    }
}

pub fn renderer_provider() -> StubRendererProvider {
    StubRendererProvider { inner: StubRenderer }
}

struct StubProcessor;

#[async_trait::async_trait]
impl Processor for StubProcessor {
    async fn process(
        &self,
        agent: &Agent,
        response: &serde_json::Value,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
        Ok(serde_json::Value::Null)
    }
}

pub struct StubProcessorProvider {
    inner: StubProcessor,
}

impl ProcessorProvider for StubProcessorProvider {
    fn openai(&self) -> Option<&dyn Processor> {
        Some(&self.inner)
    }
    fn azure(&self) -> Option<&dyn Processor> {
        Some(&self.inner)
    }
    fn custom(&self) -> Option<&dyn Processor> {
        Some(&self.inner)
    }
}

pub fn processor_provider() -> StubProcessorProvider {
    StubProcessorProvider { inner: StubProcessor }
}
