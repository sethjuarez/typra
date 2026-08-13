namespace Typra.Fixtures.Features.Vectors;

const FileBackedRenderVectors = #[
  #{
    name: "file-backed-success",
    stage: "callable",
    input: #{ request: #{ prompt: "hello from file", context: #{ locale: "en-US" } } },
    expected: #{ text: "hello from file", tokens: 3 }
  },
  #{
    name: "file-backed-error",
    stage: "callable",
    input: #{ request: #{ prompt: "", context: #{ locale: "en-US" } } },
    expectedError: #{ code: "empty-prompt" }
  }
];

// Authored as a JSON string because the inputs carry a keyword field name
// (`request.model`) and embed an opaque provider wire payload (`response`)
// whose keys include the reserved `model` — neither is expressible with a
// TypeSpec object-value literal (`#{ ... }`).
const WirePayloadVectors = """
[
  {
    "name": "wire-payload-model-key",
    "stage": "callable",
    "input": {
      "request": { "model": { "id": "cfg-1", "provider": "openai" } },
      "response": {
        "id": "resp-1",
        "model": "demo-model",
        "choices": [ { "message": { "role": "assistant", "content": "Hello!" } } ]
      }
    },
    "expected": "Hello!"
  }
]
""";
