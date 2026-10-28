package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"

	"github.com/wisely-solutions/hivenod/cli/internal/credentials"
	"github.com/wisely-solutions/hivenod/cli/internal/hive"
)

// connect (item EJ2Cxq4k): like a device login. It asks Hivenod for a request, opens the browser
// on the confirm page (any member confirms it with one click for their own projects), and saves
// the agent token it receives, sealed for a key that never leaves this process. The token is
// never printed.
func connect(ctx context.Context, cfg hive.Config, say func(string)) error {
	tok, src, err := credentials.Resolve()
	if errors.Is(err, credentials.ErrDamaged) {
		say(credentials.DamagedMessage() + " Connecting again replaces it.")
	} else if tok != "" {
		if src == credentials.FromEnv {
			say("HIVENOD_TOKEN is set: this machine already acts as that agent. Unset it to connect another one.")
		} else if s := credentials.Read(); s != nil && s.AgentName != "" {
			say(fmt.Sprintf("Already connected as %s (%s). Run hivenod logout first to connect as another agent.", s.AgentName, credentials.Path()))
		} else {
			say(fmt.Sprintf("Already connected (%s). Run hivenod logout first to connect as another agent.", credentials.Path()))
		}
		return nil
	}
	p, err := hive.PairTerminal(ctx, cfg, hive.PairOptions{CLI: "claude", Say: say, Connect: true, OpenBrowser: openBrowser})
	if err != nil {
		return err
	}
	if err := savePaired(ctx, cfg, p); err != nil {
		return err
	}
	say(fmt.Sprintf("✓ Connected: this machine is now the agent %s. Token saved in %s.", p.AgentName, credentials.Path()))
	return nil
}

// savePaired stores the token and, signed in as the new agent, removes the request.
func savePaired(ctx context.Context, cfg hive.Config, p *hive.Paired) error {
	if _, err := credentials.Save(credentials.Stored{Token: p.Token, WorkspaceID: p.WorkspaceID, AgentUID: p.AgentUID, AgentName: p.AgentName}); err != nil {
		return err
	}
	if c, err := hive.Connect(ctx, cfg, p.Token); err == nil {
		c.DeletePairing(ctx, p.Code)
		c.Close()
	}
	return nil
}

var errNoBrowser = errors.New("no browser")

// openBrowser starts the system browser on url without waiting for it. HIVENOD_NO_BROWSER=1, or
// a Linux machine without a display (SSH, a server), only prints the link.
func openBrowser(url string) error {
	if os.Getenv("HIVENOD_NO_BROWSER") != "" {
		return errNoBrowser
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
			return errNoBrowser
		}
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
