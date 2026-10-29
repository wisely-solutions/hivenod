package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// Item p6FzU: a message must never name a command that does not exist. These tests read every
// string literal of the CLI and check the `hivenod <command>` mentions against the command tree
// (the switch in run, plus the inbox words) and the tool names against surface.json.

func parseGoFiles(t *testing.T, root string, each func(path string, f *ast.File, fset *token.FileSet)) {
	t.Helper()
	err := filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() && (info.Name() == "spike" || info.Name() == "node_modules") {
			return filepath.SkipDir
		}
		if info.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			return nil
		}
		fset := token.NewFileSet()
		f, err := parser.ParseFile(fset, p, nil, 0)
		if err != nil {
			return err
		}
		each(p, f, fset)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// commandTree is the first words `hivenod` accepts: the cases of the switch on pos[0] in run,
// the inbox words, and version/help.
func commandTree(t *testing.T) map[string]bool {
	t.Helper()
	cmds := map[string]bool{"version": true, "help": true, "--help": true, "--version": true, "-h": true}
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "main.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	ast.Inspect(f, func(n ast.Node) bool {
		sw, ok := n.(*ast.SwitchStmt)
		if !ok {
			return true
		}
		if ix, ok := sw.Tag.(*ast.IndexExpr); !ok || types(ix.X) != "pos" {
			return true
		}
		for _, c := range sw.Body.List {
			for _, e := range c.(*ast.CaseClause).List {
				if bl, ok := e.(*ast.BasicLit); ok {
					s, _ := strconv.Unquote(bl.Value)
					cmds[s] = true
				}
			}
		}
		return true
	})
	for _, w := range []string{"inbox", "thread", "subject", "outcome", "claude"} {
		cmds[w] = true
	}
	if len(cmds) < 14 {
		t.Fatalf("command tree too small: %v", cmds)
	}
	return cmds
}

func types(e ast.Expr) string {
	if id, ok := e.(*ast.Ident); ok {
		return id.Name
	}
	return ""
}

func toolNames(t *testing.T) map[string]bool {
	t.Helper()
	b, err := os.ReadFile("../../internal/mcpserver/surface.json")
	if err != nil {
		t.Fatal(err)
	}
	var sf struct {
		Plain, Channel struct{ Tools []struct{ Name string } }
	}
	if err := json.Unmarshal(b, &sf); err != nil {
		t.Fatal(err)
	}
	out := map[string]bool{}
	for _, x := range append(sf.Plain.Tools, sf.Channel.Tools...) {
		out[x.Name] = true
	}
	return out
}

// prose is what may follow "hivenod" in a sentence without being a command.
var prose = map[string]bool{"plugin": true, "tool": true, "tools": true, "channel": true, "agent": true, "server": true}

// hintFiles are the files whose messages tell the agent what to do next (the channel texts have
// snake_case fields of their own and are covered by the text snapshots).
var hintFiles = map[string]bool{
	"../../internal/hive/errors.go":       true,
	"../../internal/hive/client.go":       true,
	"../../internal/hive/ops.go":          true,
	"../../internal/hive/ops2.go":         true,
	"../../internal/attachfile/attach.go": true,
}

var (
	hivenodWord = regexp.MustCompile(`hivenod (--?[a-z]+|[a-z][a-z-]*)`)
	toolLike    = regexp.MustCompile(`\b[a-z]+(?:_[a-z]+)+\b`)
	// snake_case words in messages that are fields, not tools.
	notTools = map[string]bool{"item_id": true, "run_id": true, "project_id": true, "step_id": true}
)

func TestMessagesNameOnlyRealCommandsAndTools(t *testing.T) {
	cmds, tools := commandTree(t), toolNames(t)
	var bad []string
	parseGoFiles(t, "../..", func(p string, f *ast.File, fset *token.FileSet) {
		ast.Inspect(f, func(n ast.Node) bool {
			bl, ok := n.(*ast.BasicLit)
			if !ok || bl.Kind != token.STRING {
				return true
			}
			s, _ := strconv.Unquote(bl.Value)
			at := fset.Position(bl.Pos()).String()
			for _, m := range hivenodWord.FindAllStringSubmatch(s, -1) {
				if !cmds[m[1]] && !prose[m[1]] {
					bad = append(bad, at+": `hivenod "+m[1]+"` is not a command")
				}
			}
			if hintFiles[filepath.ToSlash(p)] {
				for _, w := range toolLike.FindAllString(s, -1) {
					if !tools[w] && !notTools[w] {
						bad = append(bad, at+": `"+w+"` is not a tool in surface.json")
					}
				}
			}
			return true
		})
	})
	sort.Strings(bad)
	if len(bad) > 0 {
		t.Fatalf("messages name things that do not exist:\n%s", strings.Join(bad, "\n"))
	}
}

// Messages of the removed TypeScript CLI must not come back.
func TestNoStaleTypeScriptCommands(t *testing.T) {
	re := regexp.MustCompile(`hivenod (item|work|run)\b`)
	parseGoFiles(t, "../..", func(p string, f *ast.File, fset *token.FileSet) {
		ast.Inspect(f, func(n ast.Node) bool {
			if bl, ok := n.(*ast.BasicLit); ok && bl.Kind == token.STRING && re.MatchString(bl.Value) {
				t.Errorf("%s: names a TypeScript-only command: %s", fset.Position(bl.Pos()), bl.Value)
			}
			return true
		})
	})
	b, _ := os.ReadFile("../../internal/mcpserver/surface.json")
	if re.Match(b) {
		t.Error("surface.json names a TypeScript-only command")
	}
}
