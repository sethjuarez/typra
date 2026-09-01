// Committed typed conformance double for the `typed-seam-conformance` fixture
// (prompty#511 Cat 1 / typra#306, Track A).
//
// This is the CONSUMER's ENTIRE authored surface under the typed entrypoint: a
// real `impl Transformer` plus a one-line call into the emitted
// `run_transformer_conformance`. There is NO adapter registry, NO string keys,
// and NO per-op marshalling double — the emitted entrypoint decodes vector
// input, calls the trait method directly, and asserts. The `S: Transformer`
// bound on the entrypoint makes the compiler prove every op is implemented, so
// this file failing to compile is the red-first signal that the entrypoint was
// not emitted.
//
// The gate attaches this file as a test module of the generated crate.

use crate::model::{Note, Reviser, Transformer};

/// A minimal real seam implementation: trims, and rejects the literal "boom".
struct TransformerImpl;

#[async_trait::async_trait]
impl Transformer for TransformerImpl {
    async fn transform(
        &self,
        text: &String,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        if text.trim() == "boom" {
            return Err("boom not allowed".into());
        }
        Ok(text.trim().to_string())
    }
}

#[tokio::test]
async fn transformer_typed_vectors_pass() {
    crate::model::vector_conformance::run_transformer_conformance(&TransformerImpl).await;
}

/// A minimal real MODEL-in / MODEL-out seam: upper-cases the note title, passes
/// the body through. The typed entrypoint decodes the `note` param and the
/// expected `Note` via `Note::from_json` and asserts structural equality with
/// the plain-derive `PartialEq` — no `Serialize` on the target model.
struct ReviserImpl;

#[async_trait::async_trait]
impl Reviser for ReviserImpl {
    async fn revise(
        &self,
        note: &Note,
    ) -> Result<Note, Box<dyn std::error::Error + Send + Sync>> {
        let mut revised = note.clone();
        revised.title = note.title.to_uppercase();
        Ok(revised)
    }
}

#[tokio::test]
async fn reviser_typed_vectors_pass() {
    crate::model::vector_conformance::run_reviser_conformance(&ReviserImpl).await;
}
