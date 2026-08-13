import "@typra/emitter";
import "./sample-items.tsp";

namespace Typra.Fixtures.Features.Samples;

model Root {
  @sample(#{
    inline: #{
      name: "inline-sample",
      metadata: #{ source: "inline", priority: 1 },
      items: #[#{ id: "inline-item-1", label: "first inline item" }]
    }
  })
  inline: SampleEnvelope;

  @sample(FileBackedSamplePayload)
  fileBacked: SampleEnvelope;
}

model SampleEnvelope {
  name: string;
  metadata: Record<unknown>;
  items: SampleItem[];
}

model SampleItem {
  id: string;
  label: string;
}
