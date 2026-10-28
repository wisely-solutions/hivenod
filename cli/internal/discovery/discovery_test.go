package discovery

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"
)

// The same cases drive the TypeScript parser (packages/shared/src/discovery.test.ts).
type cases struct {
	Sites []struct {
		Name, Input, Want, Error string
	} `json:"sites"`
	Docs []struct {
		Name  string          `json:"name"`
		Site  string          `json:"site"`
		Doc   any             `json:"doc"`
		Want  json.RawMessage `json:"want"`
		Error string          `json:"error"`
	} `json:"docs"`
}

func load(t *testing.T) cases {
	t.Helper()
	raw, err := os.ReadFile("testdata/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var c cases
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

func code(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	if err != nil {
		return "other: " + err.Error()
	}
	return ""
}

func TestNormalizeSiteSharedCases(t *testing.T) {
	for _, c := range load(t).Sites {
		t.Run(c.Name, func(t *testing.T) {
			got, err := NormalizeSite(c.Input)
			if c.Error != "" {
				if code(err) != c.Error {
					t.Fatalf("want error %s, got %q %v", c.Error, got, err)
				}
				return
			}
			if err != nil || got != c.Want {
				t.Fatalf("want %q, got %q %v", c.Want, got, err)
			}
		})
	}
}

func TestParseSharedCases(t *testing.T) {
	for _, c := range load(t).Docs {
		t.Run(c.Name, func(t *testing.T) {
			got, err := Parse(c.Site, c.Doc)
			if c.Error != "" {
				if code(err) != c.Error {
					t.Fatalf("want error %s, got %+v %v", c.Error, got, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var want Discovery
			if err := json.Unmarshal(c.Want, &want); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(*got, want) {
				t.Fatalf("want %+v\n got %+v", want, *got)
			}
		})
	}
}

func TestFetch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case Path:
			_, _ = w.Write([]byte(`{"service":"hivenod","protocol":1,"firebase":{"apiKey":"k","authDomain":"a","projectId":"p"}}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	d, err := Fetch(context.Background(), srv.URL+"/")
	if err != nil {
		t.Fatal(err)
	}
	if d.Firebase.ProjectID != "p" || d.CLI != srv.URL+"/cli" || d.Site != srv.URL {
		t.Fatalf("got %+v", d)
	}
	if _, err := Fetch(context.Background(), srv.URL+"/other"); code(err) != "not-hivenod" {
		t.Fatalf("404 must be not-hivenod, got %v", err)
	}
	html := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("<!doctype html>"))
	}))
	defer html.Close()
	if _, err := Fetch(context.Background(), html.URL); code(err) != "not-hivenod" {
		t.Fatalf("html must be not-hivenod, got %v", err)
	}
	if _, err := Fetch(context.Background(), "http://your.host"); code(err) != "insecure-site" {
		t.Fatalf("got %v", err)
	}
}

func TestHelpers(t *testing.T) {
	if !IsHosted("hivenod.com") || !IsHosted("https://hivenod.com/") || IsHosted("https://your.host") {
		t.Fatal("IsHosted")
	}
	if u, _ := URL("your.host/"); u != "https://your.host/.well-known/hivenod.json" {
		t.Fatal(u)
	}
	if s, _ := NormalizeSite("https://your.host:443/"); s != "https://your.host" {
		t.Fatal(s)
	}
}
