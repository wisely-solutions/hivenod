package mcpserver

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"unicode/utf16"
)

// schema is the subset of JSON Schema the tool inputs use (generated from Zod).
type schema struct {
	Type                 string             `json:"type"`
	Properties           map[string]*schema `json:"properties"`
	Required             []string           `json:"required"`
	Items                *schema            `json:"items"`
	Enum                 []any              `json:"enum"`
	MinLength            *int               `json:"minLength"`
	MaxLength            *int               `json:"maxLength"`
	Minimum              *float64           `json:"minimum"`
	Maximum              *float64           `json:"maximum"`
	ExclusiveMinimum     *float64           `json:"exclusiveMinimum"`
	MaxItems             *int               `json:"maxItems"`
	MinItems             *int               `json:"minItems"`
	AdditionalProperties any                `json:"additionalProperties"`
}

// Validate checks args against a tool's input schema; the error names the first problem.
func Validate(raw json.RawMessage, args map[string]any) error {
	var s schema
	if err := json.Unmarshal(raw, &s); err != nil {
		return err
	}
	return check(&s, args, "")
}

func at(path string) string {
	if path == "" {
		return "input"
	}
	return path
}

// jsLen counts UTF-16 code units, as Zod's string length does.
func jsLen(s string) int { return len(utf16.Encode([]rune(s))) }

func check(s *schema, v any, path string) error {
	if len(s.Enum) > 0 {
		for _, e := range s.Enum {
			if e == v {
				return nil
			}
		}
		opts := make([]string, len(s.Enum))
		for i, e := range s.Enum {
			opts[i] = fmt.Sprintf("%q", e)
		}
		return fmt.Errorf("%s: must be one of %s", at(path), strings.Join(opts, ", "))
	}
	switch s.Type {
	case "string":
		str, ok := v.(string)
		if !ok {
			return fmt.Errorf("%s: expected string", at(path))
		}
		if s.MinLength != nil && jsLen(str) < *s.MinLength {
			return fmt.Errorf("%s: too short (at least %d characters)", at(path), *s.MinLength)
		}
		if s.MaxLength != nil && jsLen(str) > *s.MaxLength {
			return fmt.Errorf("%s: too long (at most %d characters)", at(path), *s.MaxLength)
		}
	case "number", "integer":
		n, ok := v.(float64)
		if !ok {
			return fmt.Errorf("%s: expected number", at(path))
		}
		if s.Type == "integer" && n != math.Trunc(n) {
			return fmt.Errorf("%s: expected a whole number", at(path))
		}
		if s.Minimum != nil && n < *s.Minimum {
			return fmt.Errorf("%s: must be >= %v", at(path), *s.Minimum)
		}
		if s.ExclusiveMinimum != nil && n <= *s.ExclusiveMinimum {
			return fmt.Errorf("%s: must be > %v", at(path), *s.ExclusiveMinimum)
		}
		if s.Maximum != nil && n > *s.Maximum {
			return fmt.Errorf("%s: must be <= %v", at(path), *s.Maximum)
		}
	case "boolean":
		if _, ok := v.(bool); !ok {
			return fmt.Errorf("%s: expected boolean", at(path))
		}
	case "array":
		arr, ok := v.([]any)
		if !ok {
			return fmt.Errorf("%s: expected array", at(path))
		}
		if s.MaxItems != nil && len(arr) > *s.MaxItems {
			return fmt.Errorf("%s: at most %d entries", at(path), *s.MaxItems)
		}
		if s.MinItems != nil && len(arr) < *s.MinItems {
			return fmt.Errorf("%s: at least %d entries", at(path), *s.MinItems)
		}
		if s.Items != nil {
			for i, e := range arr {
				if err := check(s.Items, e, fmt.Sprintf("%s[%d]", path, i)); err != nil {
					return err
				}
			}
		}
	case "object":
		obj, ok := v.(map[string]any)
		if !ok {
			return fmt.Errorf("%s: expected object", at(path))
		}
		for _, r := range s.Required {
			if _, ok := obj[r]; !ok {
				return fmt.Errorf("%s: required", join(path, r))
			}
		}
		keys := make([]string, 0, len(obj))
		for k := range obj {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			p := s.Properties[k]
			if p == nil {
				continue // Zod strips unknown keys
			}
			if err := check(p, obj[k], join(path, k)); err != nil {
				return err
			}
		}
	}
	return nil
}

func join(path, k string) string {
	if path == "" {
		return k
	}
	return path + "." + k
}

// Strip drops top-level arguments the schema does not know (Zod strips them too).
func Strip(raw json.RawMessage, args map[string]any) map[string]any {
	var s schema
	if json.Unmarshal(raw, &s) != nil || s.Properties == nil {
		return args
	}
	out := map[string]any{}
	for k, v := range args {
		if s.Properties[k] != nil {
			out[k] = v
		}
	}
	return out
}

// HasProperty reports whether an input schema has a top-level property.
func HasProperty(raw json.RawMessage, key string) bool {
	var s schema
	if json.Unmarshal(raw, &s) != nil {
		return false
	}
	_, ok := s.Properties[key]
	return ok
}
