// Reference adapters for the integration fixture's @vector suite. Copied into
// the Go target's vectoradapters package by validate-fixtures before the
// generated conformance suite runs. See fixtures/integration/vector-adapters.
package vectoradapters

// Context mirrors the struct the generated Go conformance suite constructs.
type Context struct {
	Contract  string
	Operation string
	Vector    map[string]any
	Provider  string
	TargetAPI string
	Doubles   map[string]any
	BaseDir   string
}

// Adapter mirrors the struct the generated Go conformance suite reads.
type Adapter struct {
	Invoke    func(input any, ctx Context) (any, error)
	Normalize func(value any, ctx Context) any
}

// VectorDoubles and VectorWaivers are the registries the suite consults.
var VectorDoubles = map[string]any{}

var VectorWaivers = map[string]string{}

func authorizeInvoke(_ any, _ Context) (any, error) {
	return map[string]any{"approved": true}, nil
}

func formatInvoke(input any, _ Context) (any, error) {
	m, _ := input.(map[string]any)
	return m["messages"], nil
}

// VectorAdapters registers a reference adapter for every fixture @vector.
var VectorAdapters = map[string]Adapter{
	"CanonicalEnginePort.authorize": {Invoke: authorizeInvoke},
	"CanonicalEnginePort.format":    {Invoke: formatInvoke},
}
