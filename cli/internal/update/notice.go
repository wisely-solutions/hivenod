package update

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// NoticeEvery is how often a session looks for a newer release (item N9EEnCa1MzIw5UYfe70N).
const NoticeEvery = 24 * time.Hour

// NoticeFile is where the time of the last check is kept, inside the folder dir.
const NoticeFile = "update-check"

// Notice tells, at most once per NoticeEvery, that a newer hivenod exists: the text for the
// session, or "" when there is nothing to say (up to date, checked recently, a development
// build, or the site could not be reached; a failed check is not counted, so the next session
// tries again). The time of a successful check is kept in dir/update-check.
func (u *Updater) Notice(ctx context.Context, dir string, now time.Time) string {
	if Version == "" || Version == "0.0.0" {
		return ""
	}
	file := filepath.Join(dir, NoticeFile)
	if b, err := os.ReadFile(file); err == nil {
		if ms, err := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64); err == nil &&
			now.Sub(time.UnixMilli(ms)) < NoticeEvery && now.After(time.UnixMilli(ms)) {
			return ""
		}
	}
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	m, err := u.Latest(cctx)
	if err != nil {
		return ""
	}
	if err := os.MkdirAll(dir, 0o700); err == nil {
		_ = os.WriteFile(file, []byte(strconv.FormatInt(now.UnixMilli(), 10)), 0o600)
	}
	if !Newer(m.Version, Version) {
		return ""
	}
	return fmt.Sprintf("A newer version of the Hivenod CLI is available (%s; this one is %s): run `hivenod update`, then restart this session. Until then some newer events (for example a person's request to revise a proposal) may not reach this agent.", m.Version, Version)
}
