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
from fixtures import Assembler, Collator, Note, Reviser, Transformer
from fixtures.vector_conformance import (
    run_assembler_conformance,
    run_collator_conformance,
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


class CollatorImpl:
    # An array-in / array-out seam: reverse the notes, each passing through
    # unchanged. The notes arrive as a decoded list[Note] (per-element
    # Note.load); return a list[Note] so the entrypoint's per-element `.save()`
    # compare stays canonical.
    def collate(self, notes: list[Note]) -> list[Note]:
        return list(reversed(notes))

    async def collate_async(self, notes: list[Note]) -> list[Note]:
        return self.collate(notes)


class AssemblerImpl:
    # A carrier-param seam: the note flows through typed while `options` is an
    # untyped dict[str, Any] carrier (prompty's Renderer.render `inputs`).
    # `reassemble` takes the OPTIONAL carrier (Parser.parse `context?`), which
    # lowers to `dict[str, Any] | None`; the absent-carrier vector proves an
    # omitted optional carrier decodes to None. The impls ignore `options` — the
    # point is only that the untyped param decodes and the Note[] return compares.
    def assemble(self, note: Note, options: dict[str, object]) -> list[Note]:
        return [note]

    async def assemble_async(
        self, note: Note, options: dict[str, object]
    ) -> list[Note]:
        return self.assemble(note, options)

    def reassemble(
        self, note: Note, options: "dict[str, object] | None"
    ) -> list[Note]:
        return [note]

    async def reassemble_async(
        self, note: Note, options: "dict[str, object] | None"
    ) -> list[Note]:
        return self.reassemble(note, options)


def test_transformer_typed_conformance():
    impl = TransformerImpl()
    assert isinstance(impl, Transformer)
    run_transformer_conformance(impl)


def test_reviser_typed_conformance():
    impl = ReviserImpl()
    assert isinstance(impl, Reviser)
    run_reviser_conformance(impl)


def test_collator_typed_conformance():
    impl = CollatorImpl()
    assert isinstance(impl, Collator)
    run_collator_conformance(impl)


def test_assembler_typed_conformance():
    impl = AssemblerImpl()
    assert isinstance(impl, Assembler)
    run_assembler_conformance(impl)
