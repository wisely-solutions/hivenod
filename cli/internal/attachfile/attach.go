// Package attachfile turns an attach source (file path or URL) into an attachment
// (ported from the former TypeScript client's attach.ts and safepath.ts): type by extension, inlined up to 900 KB, links
// for anything bigger, and never a file from Hivenod's own credentials folder, also not through
// symlinks or hard links.
package attachfile

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/wisely-solutions/hivenod/cli/internal/credentials"
)

// MaxBytes mirrors MAX_ATTACHMENT_BYTES in packages/shared/src/schema.ts.
const MaxBytes = 900 * 1024

// Error is a message for the caller (shown as is).
type Error struct{ Msg string }

func (e *Error) Error() string { return e.Msg }

func errf(f string, a ...any) error { return &Error{Msg: fmt.Sprintf(f, a...)} }

// Prepared is what the attach action needs.
type Prepared struct {
	Kind    string
	Name    string
	Content string
	URL     string
	HasURL  bool
}

type ftype struct{ kind, mime string }

var types = map[string]ftype{
	".html": {kind: "html"}, ".htm": {kind: "html"},
	".md": {kind: "markdown"}, ".markdown": {kind: "markdown"},
	".txt":  {kind: "text"},
	".png":  {kind: "image", mime: "image/png"},
	".jpg":  {kind: "image", mime: "image/jpeg"},
	".jpeg": {kind: "image", mime: "image/jpeg"},
	".pdf":  {kind: "pdf", mime: "application/pdf"},
}

var urlRE = regexp.MustCompile(`(?i)^https?://`)

// IsURL reports whether source is an http(s) URL.
func IsURL(s string) bool { return urlRE.MatchString(s) }

func kb(n int) string { return fmt.Sprintf("%d KB", (n+1023)/1024) }

// clip200 keeps at most 200 UTF-16 code units, like String.slice(0, 200).
func clip200(s string) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= 200 {
		return s
	}
	return string(utf16.Decode(u[:200]))
}

// Prepare reads the source. name overrides the display name; deny adds protected folders.
func Prepare(source, name string, deny []string) (*Prepared, error) {
	if IsURL(source) {
		u, err := url.Parse(source)
		if err != nil || u.Host == "" {
			return nil, errf("%q is not a valid URL", source)
		}
		n := name
		if n == "" {
			parts := strings.FieldsFunc(u.EscapedPath(), func(r rune) bool { return r == '/' })
			if len(parts) > 0 {
				n = parts[len(parts)-1]
			} else {
				n = u.Hostname()
			}
		}
		return &Prepared{Kind: "link", Name: clip200(n), URL: source, HasURL: true}, nil
	}
	t, ok := types[strings.ToLower(filepath.Ext(source))]
	if !ok {
		return nil, errf("Cannot attach %q: use html, md, txt, png, jpg or pdf, or attach a URL instead.", filepath.Base(source))
	}
	f, err := OpenGuarded(source, deny)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, errf("File not found: %s", source)
	}
	base := filepath.Base(source)
	tooBig := func(what string) error {
		return errf("%s is %s, over the %s limit for inline attachments. Host it somewhere and attach its URL instead: hivenod item attach <itemId> https://…", base, what, kb(MaxBytes))
	}
	size := int(st.Size())
	if size > MaxBytes {
		return nil, tooBig(kb(size))
	}
	data, err := io.ReadAll(io.LimitReader(f, MaxBytes+1))
	if err != nil {
		return nil, errf("File not found: %s", source)
	}
	if len(data) > MaxBytes {
		return nil, tooBig(kb(len(data)))
	}
	n := name
	if n == "" {
		n = base
	}
	n = clip200(n)
	if t.mime != "" {
		content := "data:" + t.mime + ";base64," + base64.StdEncoding.EncodeToString(data)
		if len(content) > MaxBytes {
			return nil, tooBig(fmt.Sprintf("%s (%s once encoded)", kb(size), kb(len(content))))
		}
		return &Prepared{Kind: t.kind, Name: n, Content: content}, nil
	}
	content := string(data)
	if !utf8.ValidString(content) {
		// Like Buffer.toString('utf8'): invalid bytes become U+FFFD.
		content = strings.ToValidUTF8(content, "�")
	}
	if len(content) > MaxBytes {
		return nil, tooBig(kb(size))
	}
	return &Prepared{Kind: t.kind, Name: n, Content: content}, nil
}

// ProtectedMessage refuses a file in the credentials folder.
const ProtectedMessage = "Files in the Hivenod credentials folder cannot be attached."

func legacyHome() string {
	h, _ := os.UserHomeDir()
	return filepath.Join(h, ".hive")
}

// ProtectedDirs is the credentials folder, the old CLI's folder, and any extra ones.
func ProtectedDirs(extra []string) []string {
	return append([]string{credentials.Home(), legacyHome()}, extra...)
}

func real(p string) string {
	abs, _ := filepath.Abs(p)
	if r, err := filepath.EvalSymlinks(abs); err == nil {
		return r
	}
	return abs
}

func inside(dir, p string) bool {
	rel, err := filepath.Rel(dir, p)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel))
}

func protectedDirOf(p string, dirs []string) string {
	for _, d := range dirs {
		abs, _ := filepath.Abs(d)
		if inside(abs, p) || inside(real(d), p) {
			return d
		}
	}
	return ""
}

// AssertNotProtected refuses a path that is, as written or resolved, in a protected folder.
func AssertNotProtected(path string, extra []string) error {
	dirs := ProtectedDirs(extra)
	abs, _ := filepath.Abs(path)
	if protectedDirOf(abs, dirs) != "" || protectedDirOf(real(abs), dirs) != "" {
		return &Error{Msg: ProtectedMessage}
	}
	return nil
}

// protectedFiles lists the files in the protected folders (a few levels deep).
func protectedFiles(dirs []string) []os.FileInfo {
	var out []os.FileInfo
	budget := 2000
	var walk func(dir string, depth int)
	walk = func(dir string, depth int) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range entries {
			budget--
			if budget < 0 {
				return
			}
			p := filepath.Join(dir, e.Name())
			st, err := os.Lstat(p)
			if err != nil {
				continue
			}
			if st.Mode().IsRegular() {
				out = append(out, st)
			} else if st.IsDir() && depth < 4 {
				walk(p, depth+1)
			}
		}
	}
	for _, d := range dirs {
		walk(real(d), 0)
	}
	return out
}

// OpenGuarded opens path for reading after the checks: not in a protected folder (as written,
// resolved, by the opened file's own path on Linux, or as a hard link of a protected file), a
// regular file, and the same file that was checked.
func OpenGuarded(path string, extra []string) (*os.File, error) {
	if err := AssertNotProtected(path, extra); err != nil {
		return nil, err
	}
	dirs := ProtectedDirs(extra)
	abs, _ := filepath.Abs(path)
	target, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, errf("File not found: %s", path)
	}
	f, err := openNoFollow(target)
	if err != nil {
		return nil, errf("File not found: %s", path)
	}
	fail := func(e error) (*os.File, error) { f.Close(); return nil, e }
	st, err := f.Stat()
	if err != nil {
		return fail(errf("File not found: %s", path))
	}
	if !st.Mode().IsRegular() {
		return fail(errf("Cannot attach %q: it is not a file.", path))
	}
	now, err := os.Lstat(target)
	if err != nil {
		return fail(errf("File not found: %s", path))
	}
	if !os.SameFile(now, st) {
		return fail(errf("Cannot attach %q: it changed while it was being read.", path))
	}
	if fdPath := fdPath(f); fdPath != "" && protectedDirOf(fdPath, dirs) != "" {
		return fail(&Error{Msg: ProtectedMessage})
	}
	for _, p := range protectedFiles(dirs) {
		if os.SameFile(p, st) {
			return fail(&Error{Msg: ProtectedMessage})
		}
	}
	return f, nil
}

// IsAttachError reports an error from this package.
func IsAttachError(err error) bool {
	var e *Error
	return errors.As(err, &e)
}
