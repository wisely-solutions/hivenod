package hive

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/wisely-solutions/hivenod/cli/internal/mcpserver"
)

// ChannelServer is the shared state of `hivenod mcp --channel`: the session once started.
type ChannelServer struct {
	mu      sync.Mutex
	session *Session
}

// Set records the started session (nil: never started; tools pass calls through).
func (cs *ChannelServer) Set(s *Session) {
	cs.mu.Lock()
	cs.session = s
	cs.mu.Unlock()
}

// Get is the session, or nil.
func (cs *ChannelServer) Get() *Session {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	return cs.session
}

// Tools about one item that act on any item of the agent's projects (holding it is not needed).
var anyItem = map[string]bool{"read_item": true, "raise_finding": true}

const parkNoSession = "Parking is for a channel session (hivenod mcp --channel) that gets handovers."

// Tools that give a held item back without finishing it (item QjTTL).
var givesBack = map[string]bool{"release": true, "end_run": true}

// Not about one item.
var noItem = map[string]bool{"list_work": true, "wait_for_work": true, "claim": true}

func schemaHas(spec mcpserver.ToolSpec, key string) bool {
	return mcpserver.HasProperty(spec.InputSchema, key)
}

// ChannelTools are the tools of a channel session: no wait_for_work, claim refused while the
// session gets handovers, ask holds the item, and the item tools are per handed-over item
// (itemId/runId optional and filled in from the held items).
func ChannelTools(lazy *Lazy, cs *ChannelServer) []mcpserver.Tool {
	sf := mcpserver.LoadSurface()
	out := make([]mcpserver.Tool, 0, len(sf.Channel.Tools))
	for _, spec := range sf.Channel.Tools {
		spec := spec
		run, ok := ToolRuns[spec.Name]
		if !ok {
			panic(fmt.Sprintf("hive: no Go handler for tool %s", spec.Name))
		}
		name := spec.Name
		switch name {
		case "claim":
			base := run
			run = func(ctx context.Context, c *Client, a Args) (any, error) {
				if s := cs.Get(); s != nil && !s.IsBusy() {
					return nil, Errf(ChannelClaimMessage)
				}
				return base(ctx, c, a)
			}
		case "park":
			run = func(ctx context.Context, c *Client, a Args) (any, error) {
				s := cs.Get()
				if s == nil || s.IsBusy() {
					return nil, Errf(parkNoSession)
				}
				return s.Park(ctx, a.S("itemId"), a.S("reason"), a.S("project"))
			}
		case "unpark":
			run = func(ctx context.Context, c *Client, a Args) (any, error) {
				s := cs.Get()
				if s == nil || s.IsBusy() {
					return nil, Errf(parkNoSession)
				}
				if err := s.WakeItem(ctx, a.S("itemId")); err != nil {
					return nil, err
				}
				return map[string]any{"itemId": a.S("itemId"), "parked": nil}, nil
			}
		case "ask":
			base := run
			run = func(ctx context.Context, c *Client, a Args) (any, error) {
				if s := cs.Get(); s != nil {
					return s.AskAndHold(ctx, a.S("itemId"), a.S("question"), a.S("project"))
				}
				return base(ctx, c, a)
			}
		}
		hasItem := schemaHas(spec, "itemId") && !noItem[name] && name != "raise_finding"
		hasRun := schemaHas(spec, "runId") && !noItem[name]
		if hasItem || hasRun {
			inner := run
			run = func(ctx context.Context, c *Client, a Args) (any, error) {
				s := cs.Get()
				args := Args{}
				for k, v := range a {
					args[k] = v
				}
				itemID, runID := args.S("itemId"), args.S("runId")
				held := ""
				switch {
				case s == nil || s.IsBusy():
					if hasItem && itemID == "" {
						return nil, Errf(name + " needs itemId.")
					}
					if hasRun && runID == "" {
						return nil, Errf(name + " needs runId.")
					}
				case anyItem[name] && itemID != "":
					// reading any item of the agent's projects is fine; a call on a parked one wakes it
					if s.IsParked(itemID) {
						if err := s.WakeItem(ctx, itemID); err != nil {
							return nil, err
						}
					}
				default:
					h, err := s.Resolve(name, itemID, runID)
					if err != nil {
						return nil, err
					}
					held = h.ItemID
					if hasItem {
						args["itemId"] = h.ItemID
						if !args.Has("project") {
							args["project"] = h.ProjectID
						}
					}
					if hasRun {
						args["runId"] = h.RunID
					}
					// Any tool call on a parked item makes it active again (item QjTTL), before it.
					if name != "park" {
						if err := s.WakeItem(ctx, h.ItemID); err != nil {
							return nil, err
						}
					}
				}
				if !hasItem {
					delete(args, "itemId")
				}
				// Reach out (item KZ6O9): any tool call on a held item shows the agent is at work on it.
				if s != nil {
					touched := held
					if touched == "" && anyItem[name] {
						touched = itemID
					}
					if touched != "" {
						s.Touched(touched, name)
					}
				}
				if held == "" || !givesBack[name] {
					return inner(ctx, c, args)
				}
				// Given back: not handed to this session again for a while (item QjTTL). Marked
				// before the write, since the handover ends (and the next look starts) as soon as
				// the claim goes.
				s.GaveBack(held)
				res, err := inner(ctx, c, args)
				if err != nil {
					s.ForgetGiveBack(held)
				}
				return res, err
			}
		}
		final := scoped(name, run)
		out = append(out, mcpserver.Tool{Spec: spec, Run: func(ctx context.Context, args map[string]any) (any, error) {
			c, err := lazy.Get(ctx)
			if err != nil {
				return nil, err
			}
			res, err := final(ctx, c, Args(args))
			if err != nil {
				return nil, errors.New(Message(err))
			}
			return res, nil
		}})
	}
	return out
}
