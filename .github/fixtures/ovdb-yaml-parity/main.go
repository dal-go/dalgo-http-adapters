// Synthetic serialization parity only; no HTTP, provider, server or source data.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"

	"github.com/dal-go/dalgo/dtql"
	"gopkg.in/yaml.v3"
)

type input struct {
	Body   string   `json:"body"`
	Values []string `json:"values"`
	Limit  int      `json:"limit"`
}

func values(body []byte) ([]string, error) {
	var doc map[string]any
	if err := yaml.Unmarshal(body, &doc); err != nil {
		return nil, err
	}
	var out = []string{}
	if doc["where"] == nil {
		return out, nil
	}
	where := doc["where"].(map[string]any)
	comparisons := []any{where}
	if and, ok := where["and"]; ok {
		comparisons = and.([]any)
	}
	for _, raw := range comparisons {
		comparison := raw.(map[string]any)
		value, ok := comparison["right"].(map[string]any)["value"].(string)
		if !ok {
			return nil, fmt.Errorf("native equality lost string type")
		}
		out = append(out, value)
	}
	return out, nil
}
func run() error {
	var inputs []input
	if err := json.NewDecoder(os.Stdin).Decode(&inputs); err != nil {
		return err
	}
	for index, in := range inputs {
		query, err := dtql.Deserialize([]byte(in.Body))
		if err != nil {
			return fmt.Errorf("case %d: %w", index, err)
		}
		if query.Limit() != in.Limit {
			return fmt.Errorf("limit changed")
		}
		decoded, err := values([]byte(in.Body))
		if err != nil || !reflect.DeepEqual(decoded, in.Values) {
			return fmt.Errorf("Go YAML string parity failed")
		}
		encoded, err := dtql.Serialize(query)
		if err != nil {
			return err
		}
		again, err := values(encoded)
		if err != nil || !reflect.DeepEqual(again, in.Values) {
			return fmt.Errorf("released DTQL string parity failed")
		}
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"synthetic": true, "cases": len(inputs), "parser": "github.com/dal-go/dalgo v0.93.0", "protocol": "openvaultdb-go v0.24.1", "providerRequests": 0})
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "native YAML parity failed:", err)
		os.Exit(1)
	}
}
