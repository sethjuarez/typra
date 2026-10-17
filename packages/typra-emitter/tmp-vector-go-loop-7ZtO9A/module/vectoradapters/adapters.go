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

type vectorError struct {
	message string
	payload any
}

func (e *vectorError) Error() string   { return e.message }
func (e *vectorError) TypraVector() any { return e.payload }

var VectorDoubles = map[string]any{}

func echoInvoke(input any, _ Context) (any, error) {
	m, _ := input.(map[string]any)
	payload, _ := m["payload"].(string)
	if payload == "" {
		return nil, &vectorError{message: "empty", payload: map[string]any{"code": "empty"}}
	}
	return strings.ToUpper(payload), nil
}

func sumInvoke(input any, _ Context) (any, error) {
	m, _ := input.(map[string]any)
	values, _ := m["values"].([]any)
	total := 0.0
	for _, v := range values {
		f, _ := v.(float64)
		total += f
	}
	return total, nil
}

var VectorWaivers = map[string]string{}

var _ = sumInvoke

var VectorAdapters = map[string]Adapter{
	"Echo.echo": {Invoke: echoInvoke},
}
