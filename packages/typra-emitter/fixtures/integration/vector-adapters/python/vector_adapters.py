"""Reference adapters for the integration fixture's @vector suite.

Copied into each Python target's tests/ dir by validate-fixtures before the
generated conformance suite runs. See fixtures/integration/vector-adapters.
"""


def _authorize(_input, _context):
    return {"approved": True}


def _format(input, _context):
    return input["messages"]


VECTOR_ADAPTERS = {
    "CanonicalEnginePort.authorize": {"invoke": _authorize},
    "CanonicalEnginePort.format": {"invoke": _format},
}

VECTOR_WAIVERS = {}
VECTOR_DOUBLES = {}
