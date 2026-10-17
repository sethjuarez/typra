package vectoradapters

import "strings"

type Context struct {
	Contract  string
	Operation string
	Vector    map[string]any
	Provider  string
	TargetAPI string
	Doubles   map[string]any
	BaseDir   string
}

type Adapter struct {
	Invoke    func(input any, ctx Context) (any, error)
	Normalize func(value any, ctx Context) any
}

var VectorDoubles = map[string]any{}

func echoInvoke(input any, _ Context) (any, error) {
	m, _ := input.(map[string]any)
	payload, _ := m["payload"].(string)
	return strings.ToUpper(payload), nil
}

var VectorWaivers = map[string]string{"Echo.echo:shout": "known divergence"}

var VectorAdapters = map[string]Adapter{
	"Echo.echo": {Invoke: echoInvoke},
}
