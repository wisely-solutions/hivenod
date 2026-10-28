package actions

import "encoding/json"

// Maybe is an optional input that tells "not given" (Set false, TS undefined) from null (Set
// true, V nil). Only used where the TS action treats the two differently.
type Maybe[T any] struct {
	Set bool
	V   *T
}

// Given is a set, non-null value.
func Given[T any](v T) Maybe[T] { return Maybe[T]{Set: true, V: &v} }

// Null is a set null.
func Null[T any]() Maybe[T] { return Maybe[T]{Set: true} }

// UnmarshalJSON: present (null or a value) sets Set.
func (m *Maybe[T]) UnmarshalJSON(b []byte) error {
	m.Set = true
	m.V = nil
	if string(b) == "null" {
		return nil
	}
	var v T
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	m.V = &v
	return nil
}
