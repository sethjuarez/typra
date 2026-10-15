#![allow(dead_code, unused_variables, clippy::all)]

use crate::model::direct_renderer_resolver::DirectRendererProvider;
use crate::model::optional_renderer_resolver::OptionalRendererProvider;
use crate::model::processor_resolver::ProcessorProvider;
use crate::model::renderer_resolver::RendererProvider;
use crate::model::{
    Agent, DirectRenderer, FormatConfig, OptionalRenderer, Processor, Renderer,
};

struct RendererImpl(&'static str);

#[async_trait::async_trait]
impl Renderer for RendererImpl {
    async fn render(
        &self,
        _agent: &Agent,
        _template: &String,
        _inputs: &serde_json::Value,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        Ok(self.0.to_string())
    }
}

pub struct StubRendererProvider {
    jinja2: RendererImpl,
    mustache: RendererImpl,
    custom: RendererImpl,
}

impl RendererProvider for StubRendererProvider {
    fn jinja2(&self) -> Option<&dyn Renderer> { Some(&self.jinja2) }
    fn mustache(&self) -> Option<&dyn Renderer> { Some(&self.mustache) }
    fn custom(&self) -> Option<&dyn Renderer> { Some(&self.custom) }
}

pub fn renderer_provider() -> StubRendererProvider {
    StubRendererProvider {
        jinja2: RendererImpl("renderer:jinja2"),
        mustache: RendererImpl("renderer:mustache"),
        custom: RendererImpl("renderer:custom"),
    }
}

struct ProcessorImpl(&'static str);

#[async_trait::async_trait]
impl Processor for ProcessorImpl {
    async fn process(
        &self,
        _agent: &Agent,
        _response: &serde_json::Value,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
        Ok(serde_json::json!({ "route": self.0 }))
    }
}

pub struct StubProcessorProvider {
    openai: ProcessorImpl,
    azure: ProcessorImpl,
    custom: ProcessorImpl,
}

impl ProcessorProvider for StubProcessorProvider {
    fn openai(&self) -> Option<&dyn Processor> { Some(&self.openai) }
    fn azure(&self) -> Option<&dyn Processor> { Some(&self.azure) }
    fn custom(&self) -> Option<&dyn Processor> { Some(&self.custom) }
}

pub fn processor_provider() -> StubProcessorProvider {
    StubProcessorProvider {
        openai: ProcessorImpl("processor:openai"),
        azure: ProcessorImpl("processor:azure"),
        custom: ProcessorImpl("processor:custom"),
    }
}

struct DirectRendererImpl(&'static str);

#[async_trait::async_trait]
impl DirectRenderer for DirectRendererImpl {
    async fn render(
        &self,
        _format: &FormatConfig,
        _template: &String,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        Ok(self.0.to_string())
    }
}

pub struct StubDirectRendererProvider {
    jinja2: DirectRendererImpl,
    mustache: DirectRendererImpl,
    custom: DirectRendererImpl,
}

impl DirectRendererProvider for StubDirectRendererProvider {
    fn jinja2(&self) -> Option<&dyn DirectRenderer> { Some(&self.jinja2) }
    fn mustache(&self) -> Option<&dyn DirectRenderer> { Some(&self.mustache) }
    fn custom(&self) -> Option<&dyn DirectRenderer> { Some(&self.custom) }
}

pub fn direct_renderer_provider() -> StubDirectRendererProvider {
    StubDirectRendererProvider {
        jinja2: DirectRendererImpl("direct:jinja2"),
        mustache: DirectRendererImpl("direct:mustache"),
        custom: DirectRendererImpl("direct:custom"),
    }
}

struct OptionalRendererImpl(&'static str);

#[async_trait::async_trait]
impl OptionalRenderer for OptionalRendererImpl {
    async fn render(
        &self,
        _agent: &Option<Agent>,
        _template: &String,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        Ok(self.0.to_string())
    }
}

pub struct StubOptionalRendererProvider {
    jinja2: OptionalRendererImpl,
    mustache: OptionalRendererImpl,
    custom: OptionalRendererImpl,
}

impl OptionalRendererProvider for StubOptionalRendererProvider {
    fn jinja2(&self) -> Option<&dyn OptionalRenderer> { Some(&self.jinja2) }
    fn mustache(&self) -> Option<&dyn OptionalRenderer> { Some(&self.mustache) }
    fn custom(&self) -> Option<&dyn OptionalRenderer> { Some(&self.custom) }
}

pub fn optional_renderer_provider() -> StubOptionalRendererProvider {
    StubOptionalRendererProvider {
        jinja2: OptionalRendererImpl("optional:jinja2"),
        mustache: OptionalRendererImpl("optional:mustache"),
        custom: OptionalRendererImpl("optional:custom"),
    }
}

#[test]
fn bare_discriminator_coercion_is_canonical() {
    let known = FormatConfig::load_from_value(
        &serde_json::json!("mustache"),
        &Default::default(),
    );
    let known_roundtrip = FormatConfig::load_from_value(
        &known.to_value(&Default::default()),
        &Default::default(),
    );
    assert_eq!(known, known_roundtrip);
    assert!(matches!(
        known.kind,
        crate::model::format_config::FormatConfigKind::MustacheFormat
    ));

    let unknown = FormatConfig::load_from_value(
        &serde_json::json!("liquid"),
        &Default::default(),
    );
    let unknown_roundtrip = FormatConfig::load_from_value(
        &unknown.to_value(&Default::default()),
        &Default::default(),
    );
    assert_eq!(unknown, unknown_roundtrip);
    assert!(matches!(
        unknown.kind,
        crate::model::format_config::FormatConfigKind::CustomFormat { ref kind_name, .. }
            if kind_name == "liquid"
    ));
}
