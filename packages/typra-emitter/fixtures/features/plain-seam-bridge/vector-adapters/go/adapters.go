// Compile-and-run double for the plain-seam-bridge gate (issue #511 Cat 1).
// validate-fixtures attaches this into the generated Go tree's vectoradapters
// package before running the emitted conformance suite. It demonstrates the
// WHOLE consumer cost of adopting the emitted typed adapter bridge: author one
// `bridged` helper, then register each seam op with a single line — no
// hand-authored per-op marshalling closure.
//
// Import direction proves the cycle-safety of the bridge design: this
// consumer-authored vectoradapters package imports `vectorbridge`, and
// `vectorbridge` imports only the model package (never vectoradapters), so there
// is no import cycle.
package vectoradapters

import (
	"strings"

	fixtures "fixtures"
	vectorbridge "fixtures/vectorbridge"
)

// Context mirrors the struct the generated Go conformance runner constructs.
type Context struct {
	Contract  string
	Operation string
	Vector    map[string]any
	Provider  string
	TargetAPI string
	Doubles   map[string]any
	BaseDir   string
}

// Adapter mirrors the struct the generated Go conformance runner reads.
type Adapter struct {
	Invoke    func(input any, ctx Context) (any, error)
	Normalize func(value any, ctx Context) any
}

// VectorDoubles and VectorWaivers are the registries the runner consults.
var VectorDoubles = map[string]any{}

var VectorWaivers = map[string]string{}

// bridged adapts an emitted vectorbridge decoded-invoke func into an Adapter.
// Authored ONCE and reused for every bridged op; the emitter owns all per-op
// marshalling, so the consumer never writes decode/encode boilerplate again.
func bridged(fn func(any) (any, error)) Adapter {
	return Adapter{Invoke: func(in any, _ Context) (any, error) { return fn(in) }}
}

// transformerImpl is the consumer's real typed seam implementation. The bridge
// decodes vector input into the typed `text string` param and calls this
// directly — TrimSpace satisfies both the `identity` vector (already trimmed
// input, unchanged) and the `trim` vector (padded input, trimmed).
type transformerImpl struct{}

func (transformerImpl) Transform(text string) (string, error) {
	return strings.TrimSpace(text), nil
}

var _ fixtures.Transformer = transformerImpl{}

// VectorAdapters registers the bridged seam with a single line per op.
var VectorAdapters = map[string]Adapter{
	"Transformer.transform": bridged(vectorbridge.TransformerTransform(transformerImpl{})),
}
