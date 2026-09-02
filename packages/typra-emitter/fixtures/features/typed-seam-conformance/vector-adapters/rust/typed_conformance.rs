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

use crate::model::{Assembler, Collator, Note, Reviser, Transformer};

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

/// A minimal real ARRAY-in / ARRAY-out seam: reverses the notes, each note
/// passing through unchanged. The typed entrypoint decodes the `notes` param
/// and the expected `Vec<Note>` element-wise through `Note::from_json` and
/// asserts equality with `Vec<Note>`'s `PartialEq` — no `Serialize` on the
/// target model.
struct CollatorImpl;

#[async_trait::async_trait]
impl Collator for CollatorImpl {
    async fn collate(
        &self,
        notes: &Vec<Note>,
    ) -> Result<Vec<Note>, Box<dyn std::error::Error + Send + Sync>> {
        let mut reversed = notes.clone();
        reversed.reverse();
        Ok(reversed)
    }
}

#[tokio::test]
async fn collator_typed_vectors_pass() {
    crate::model::vector_conformance::run_collator_conformance(&CollatorImpl).await;
}

/// A minimal real CARRIER-in / ARRAY-out seam: wraps the note in a one-element
/// `Vec`, ignoring the untyped `options` carrier. The typed entrypoint decodes
/// `options` via `serde_json::from_str::<serde_json::Value>` (or
/// `Option<serde_json::Value>` for the OPTIONAL carrier) — the same serde-native
/// path as any scalar — and threads the parsed bag straight through to the call.
/// The RETURN keeps its own array-of-model rule (`Note::from_json` element-wise),
/// so the untyped carrier param never loosens the result check.
struct AssemblerImpl;

#[async_trait::async_trait]
impl Assembler for AssemblerImpl {
    async fn assemble(
        &self,
        note: &Note,
        _options: &serde_json::Value,
    ) -> Result<Vec<Note>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(vec![note.clone()])
    }

    async fn reassemble(
        &self,
        note: &Note,
        _options: &Option<serde_json::Value>,
    ) -> Result<Vec<Note>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(vec![note.clone()])
    }
}

#[tokio::test]
async fn assembler_typed_vectors_pass() {
    crate::model::vector_conformance::run_assembler_conformance(&AssemblerImpl).await;
}
