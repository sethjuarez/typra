# Committed consumer double for the Python typed @vector conformance entrypoint
# (issue #511 Cat 1, typra#306 Track A). This is the WHOLE authored surface a
# consumer needs to migrate a plain seam off the stringly vector_adapters
# registry: a real Protocol impl and one typed call to the emitted
# run_<seam>_conformance. No registry, no string keys, no per-op marshalling
# double. Transformer covers the scalar rail; Reviser covers the Phase 2
# model-in/model-out rail (its boundary model Note is in the @serializable
# closure, so the entrypoint decodes via Note.load and compares via .save()).
#
# The `from fixtures.vector_conformance import ...` resolves only when the emitter
# emits vector_conformance.py; on `main` it does not exist, so this test fails to
# collect (the red-first signal). The @runtime_checkable isinstance assertion
# checks that every op is present at runtime; a static checker enforces it from
# the Protocol annotation on run_<seam>_conformance.
from fixtures import Note, Reviser, Transformer
from fixtures.vector_conformance import (
    run_reviser_conformance,
    run_transformer_conformance,
)


class TransformerImpl:
    def transform(self, text: str) -> str:
        if text == "boom":
            raise ValueError("boom not allowed")
        return text.strip()

    async def transform_async(self, text: str) -> str:
        return self.transform(text)


class ReviserImpl:
    # A model-in / model-out seam: upper-case the note title, pass the body
    # through. The note arrives as a decoded Note (Note.load); mutate and return
    # it so the result stays a Note for the entrypoint's `.save()` compare.
    def revise(self, note: Note) -> Note:
        note.title = note.title.upper()
        return note

    async def revise_async(self, note: Note) -> Note:
        return self.revise(note)


def test_transformer_typed_conformance():
    impl = TransformerImpl()
    assert isinstance(impl, Transformer)
    run_transformer_conformance(impl)


def test_reviser_typed_conformance():
    impl = ReviserImpl()
    assert isinstance(impl, Reviser)
    run_reviser_conformance(impl)
