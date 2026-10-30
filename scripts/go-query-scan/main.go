// go-query-scan finds the Firestore queries in Go sources (stdlib only, no network) and prints
// them as JSON for scripts/firestore-index-scan.mjs. A query is a chain
// `<x>.Collection(p)|CollectionGroup(id)` followed by Where/OrderBy/... calls. Chains with no
// Where/OrderBy need no index and are skipped. Anything it cannot resolve to literals is reported
// with an "error" so the guard fails closed (or the site is allowlisted with a reason).
//
// Usage: go run scripts/go-query-scan/main.go <repo root> <file.go>...   (paths relative to root)
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

type filter struct {
	Field string `json:"field"`
	Op    string `json:"op"`
}
type order struct {
	Field string `json:"field"`
	Dir   string `json:"dir"`
}
type query struct {
	File    string   `json:"file"`
	Line    int      `json:"line"`
	Text    string   `json:"text"`
	Group   string   `json:"group,omitempty"`
	Scope   string   `json:"scope,omitempty"`
	Filters []filter `json:"filters"`
	Orders  []order  `json:"orders"`
	Error   string   `json:"error,omitempty"`
}

// builders: path-builder functions whose result ends in a known collection id. "" means the id is
// the last string-literal argument of the call.
var builders = map[string]string{
	"model.Paths.InboxCollection": "",
}

var ignored = map[string]bool{"Limit": true, "LimitToLast": true, "Offset": true, "Select": true,
	"StartAt": true, "StartAfter": true, "EndAt": true, "EndBefore": true}
var unmodelled = map[string]bool{"WhereEntity": true, "WherePath": true, "OrderByPath": true}

var ws = regexp.MustCompile(`\s+`)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: go-query-scan <root> <file.go>...")
		os.Exit(2)
	}
	root := os.Args[1]
	fset := token.NewFileSet()
	var files []*ast.File
	var rels []string
	consts := map[string]string{}
	for _, rel := range os.Args[2:] {
		f, err := parser.ParseFile(fset, filepath.Join(root, rel), nil, 0)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		files = append(files, f)
		rels = append(rels, rel)
		for _, d := range f.Decls {
			g, ok := d.(*ast.GenDecl)
			if !ok || g.Tok != token.CONST {
				continue
			}
			for _, s := range g.Specs {
				v := s.(*ast.ValueSpec)
				for i, n := range v.Names {
					if i < len(v.Values) {
						if lit, ok := v.Values[i].(*ast.BasicLit); ok && lit.Kind == token.STRING {
							if s, err := strconv.Unquote(lit.Value); err == nil {
								consts[n.Name] = s
							}
						}
					}
				}
			}
		}
	}
	text := func(n ast.Node) string {
		var b strings.Builder
		_ = printer.Fprint(&b, fset, n)
		return ws.ReplaceAllString(b.String(), " ")
	}
	str := func(e ast.Expr) (string, bool) {
		switch x := e.(type) {
		case *ast.BasicLit:
			if x.Kind == token.STRING {
				s, err := strconv.Unquote(x.Value)
				return s, err == nil
			}
		case *ast.Ident:
			s, ok := consts[x.Name]
			return s, ok
		}
		return "", false
	}
	// lastSegment: the collection id a path expression ends in.
	var lastSegment func(e ast.Expr) (string, bool)
	lastSegment = func(e ast.Expr) (string, bool) {
		if s, ok := str(e); ok {
			parts := strings.Split(s, "/")
			return parts[len(parts)-1], parts[len(parts)-1] != ""
		}
		if b, ok := e.(*ast.BinaryExpr); ok && b.Op == token.ADD {
			// the right operand must itself be a literal that carries a "/" so the id is known
			if s, ok := str(b.Y); ok && strings.Contains(s, "/") {
				return lastSegment(b.Y)
			}
		}
		if c, ok := e.(*ast.CallExpr); ok {
			if want, ok := builders[text(c.Fun)]; ok {
				if want != "" {
					return want, true
				}
				return lastSegment(c.Args[len(c.Args)-1])
			}
		}
		return "", false
	}
	dirOf := func(e ast.Expr) (string, bool) {
		if s, ok := e.(*ast.SelectorExpr); ok {
			switch s.Sel.Name {
			case "Asc":
				return "asc", true
			case "Desc":
				return "desc", true
			}
		}
		return "", false
	}

	out := []query{}
	for i, f := range files {
		done := map[ast.Node]bool{}
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || done[call] {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			name := sel.Sel.Name
			if name != "Where" && name != "OrderBy" && !unmodelled[name] {
				return true
			}
			// outermost call of a chain: unwind receivers.
			var chain []*ast.CallExpr
			var cur ast.Expr = call
			var base *ast.CallExpr
			for {
				c, ok := cur.(*ast.CallExpr)
				if !ok {
					break
				}
				s, ok := c.Fun.(*ast.SelectorExpr)
				if !ok {
					break
				}
				if s.Sel.Name == "Collection" || s.Sel.Name == "CollectionGroup" {
					base = c
					break
				}
				done[c] = true
				chain = append([]*ast.CallExpr{c}, chain...)
				cur = s.X
			}
			q := query{File: rels[i], Line: fset.Position(call.Pos()).Line, Text: text(call), Filters: []filter{}, Orders: []order{}}
			if base == nil {
				q.Error = "the query base is not a Collection()/CollectionGroup() call"
				out = append(out, q)
				return true
			}
			q.Line = fset.Position(base.Pos()).Line
			bs := base.Fun.(*ast.SelectorExpr).Sel.Name
			q.Scope = "COLLECTION"
			if bs == "CollectionGroup" {
				q.Scope = "COLLECTION_GROUP"
			}
			if len(base.Args) != 1 {
				q.Error = "unexpected Collection() arguments"
			} else if g, ok := lastSegment(base.Args[0]); ok {
				q.Group = g
			} else {
				q.Error = "collection id at the end of the path is not a literal"
			}
			for _, c := range chain {
				fn := c.Fun.(*ast.SelectorExpr).Sel.Name
				switch {
				case ignored[fn]:
				case unmodelled[fn]:
					if q.Error == "" {
						q.Error = fn + "() is not modelled"
					}
				case fn == "Where" && len(c.Args) == 3:
					field, ok1 := str(c.Args[0])
					op, ok2 := str(c.Args[1])
					if !ok1 || !ok2 {
						if q.Error == "" {
							q.Error = "Where() field or operator is not a literal"
						}
					} else {
						q.Filters = append(q.Filters, filter{field, op})
					}
				case fn == "OrderBy" && len(c.Args) == 2:
					field, ok1 := str(c.Args[0])
					dir, ok2 := dirOf(c.Args[1])
					if !ok1 || !ok2 {
						if q.Error == "" {
							q.Error = "OrderBy() field or direction is not a literal"
						}
					} else {
						q.Orders = append(q.Orders, order{field, dir})
					}
				default:
					if q.Error == "" {
						q.Error = "unexpected " + fn + "() call in the query chain"
					}
				}
			}
			out = append(out, q)
			return true
		})
	}
	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(out); err != nil {
		os.Exit(2)
	}
}
