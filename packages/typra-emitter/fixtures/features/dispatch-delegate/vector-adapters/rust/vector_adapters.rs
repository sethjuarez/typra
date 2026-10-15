use crate::model::{MetaRenderer, MetaRequest, Renderer, RendererWithoutVectors, Request};

#[derive(Default)]
pub struct Jinja2Renderer;
#[async_trait::async_trait]
impl Renderer for Jinja2Renderer {
    async fn render(&self, request: &Request) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        Ok(format!("jinja2:{}", request.text))
    }
}
#[derive(Default)]
pub struct NoVectorJinja2Renderer;
#[async_trait::async_trait]
impl RendererWithoutVectors for NoVectorJinja2Renderer {
    async fn render(&self, request: &Request) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        Ok(format!("jinja2:{}", request.text))
    }
}

#[derive(Default)]
pub struct MustacheRenderer;
#[async_trait::async_trait]
impl Renderer for MustacheRenderer {
    async fn render(&self, request: &Request) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        Ok(format!("mustache:{}", request.text))
    }
}
#[derive(Default)]
pub struct NoVectorMustacheRenderer;
#[async_trait::async_trait]
impl RendererWithoutVectors for NoVectorMustacheRenderer {
    async fn render(&self, request: &Request) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        Ok(format!("mustache:{}", request.text))
    }
}

#[derive(Default)]
pub struct CustomRenderer;
#[async_trait::async_trait]
impl Renderer for CustomRenderer {
    async fn render(&self, request: &Request) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        Ok(format!("custom:{}", request.text))
    }
}
#[derive(Default)]
pub struct NoVectorCustomRenderer;
#[async_trait::async_trait]
impl RendererWithoutVectors for NoVectorCustomRenderer {
    async fn render(&self, request: &Request) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        Ok(format!("custom:{}", request.text))
    }
}

#[derive(Default)]
pub struct TypeRenderer;
#[async_trait::async_trait]
impl MetaRenderer for TypeRenderer {
    async fn render(&self, _request: &MetaRequest) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        Ok("type".to_string())
    }
}

#[derive(Default)]
pub struct KindRenderer;
#[async_trait::async_trait]
impl MetaRenderer for KindRenderer {
    async fn render(&self, _request: &MetaRequest) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        Ok("kind".to_string())
    }
}
