# Committed consumer double for the Python typed @vector conformance entrypoint
# (issue #511 Cat 1, typra#306 Track A). This is the WHOLE authored surface a
# consumer needs to migrate a plain seam off the stringly vector_adapters
# registry: a real Transformer Protocol impl and one typed call to the emitted
# run_transformer_conformance. No registry, no string keys, no per-op marshalling
# double.
#
# The `from fixtures.vector_conformance import ...` resolves only when the emitter
# emits vector_conformance.py; on `main` it does not exist, so this test fails to
# collect (the red-first signal). The @runtime_checkable isinstance assertion
# checks that every op is present at runtime; a static checker enforces it from
# the `Transformer` annotation on run_transformer_conformance.
from fixtures import Transformer
from fixtures.vector_conformance import run_transformer_conformance


class TransformerImpl:
    def transform(self, text: str) -> str:
        if text == "boom":
            raise ValueError("boom not allowed")
        return text.strip()

    async def transform_async(self, text: str) -> str:
        return self.transform(text)


def test_transformer_typed_conformance():
    impl = TransformerImpl()
    assert isinstance(impl, Transformer)
    run_transformer_conformance(impl)
