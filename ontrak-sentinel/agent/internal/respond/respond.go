// Package respond is the agent's *hand*: the place where a detection becomes a change on the
// host.
//
// It is written as an injected-action type rather than a pile of `exec.Command` calls so the
// decision and the side effect are separable: a dry run (the shipped default) is the exact same
// code path with the side effect replaced, and the tests drive the real decision logic without
// killing a process or editing a firewall.
//
// Three properties are the point:
//
//   - **Nothing here decides whether to act.** That is `detect.Autonomous`, applied by the
//     caller. This package only knows *how*.
//   - **Every action answers with an outcome, never throws.** An action that could not be taken
//     is recorded and reported, so the agent's log and the server both see the attempt — a host
//     action that silently failed is worse than one that was never tried.
//   - **The risky ones are opt-in.** Killing a process and editing a firewall are real; the agent
//     runs dry by default and a deployment turns enforcement on with `SENTINEL_AGENT_ENFORCE=1`.
package respond

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"

	"sentinel-agent/internal/detect"
)

// ExecFunc runs a command. Injected so a test can observe the firewall call without a firewall.
type ExecFunc func(ctx context.Context, name string, args ...string) error

// KillFunc ends a process. Injected for the same reason.
type KillFunc func(pid int) error

// Outcome is what attempting an action produced.
type Outcome struct {
	RuleID string
	Action detect.Action
	// Detail is a human sentence for the log and the chain.
	Detail string
	// Err is empty on success; a non-empty error is the *plane refused* case, recorded not fatal.
	Err string
}

// OK reports whether the action reached the host (or was deliberately a dry run).
func (o Outcome) OK() bool { return o.Err == "" }

// Responder performs host actions. The zero value is unusable; build one with New.
type Responder struct {
	// DryRun, when true, records every action and changes nothing on the host.
	DryRun bool
	Exec   ExecFunc
	Kill   KillFunc
	Logf   func(format string, args ...any)
}

// New builds a responder. DryRun is the caller's choice; the agent's env decides.
func New(dryRun bool) *Responder {
	return &Responder{
		DryRun: dryRun,
		Exec: func(ctx context.Context, name string, args ...string) error {
			return exec.CommandContext(ctx, name, args...).Run()
		},
		Kill: func(pid int) error {
			process, err := os.FindProcess(pid)
			if err != nil {
				return err
			}
			return process.Kill()
		},
		Logf: func(format string, args ...any) {},
	}
}

// Act carries out one detection's action.
func (r *Responder) Act(ctx context.Context, detection detect.Detection) Outcome {
	outcome := Outcome{RuleID: detection.RuleID, Action: detection.Action, Detail: detection.Detail}

	switch detection.Action {
	case detect.ActionMonitor:
		outcome.Detail = "observed only; no host change"
		return outcome

	case detect.ActionKill:
		if detection.PID <= 0 {
			outcome.Detail = "nothing to kill: the detection named no process"
			return outcome
		}
		if r.DryRun {
			outcome.Detail = fmt.Sprintf("would kill %s (pid %d)", processName(detection), detection.PID)
			return outcome
		}
		if err := r.Kill(detection.PID); err != nil {
			outcome.Err = fmt.Sprintf("kill pid %d: %v", detection.PID, err)
			return outcome
		}
		outcome.Detail = fmt.Sprintf("killed %s (pid %d)", processName(detection), detection.PID)
		return outcome

	case detect.ActionQuarantine:
		// Persistence is recorded and raised; disabling the exact mechanism is deliberately left
		// to a person, because a wrong automated edit to a scheduled task or an authorized_keys
		// file is an outage, and the detection already carries the evidence to act on.
		outcome.Detail = "recorded for review; persistence mechanisms are not edited automatically"
		return outcome

	case detect.ActionBlock:
		return r.block(ctx, detection)

	default:
		outcome.Err = "unknown action: " + string(detection.Action)
		return outcome
	}
}

// block drops traffic to or from an address using the platform's own firewall.
func (r *Responder) block(ctx context.Context, detection detect.Detection) Outcome {
	outcome := Outcome{RuleID: detection.RuleID, Action: detect.ActionBlock}
	address := detection.Address
	if address == "" {
		outcome.Err = "block named no address"
		return outcome
	}
	command, args, err := firewallCommand(runtime.GOOS, address)
	if err != nil {
		outcome.Err = err.Error()
		return outcome
	}
	if r.DryRun {
		outcome.Detail = fmt.Sprintf("would run: %s %v", command, args)
		return outcome
	}
	if err := r.Exec(ctx, command, args...); err != nil {
		outcome.Err = fmt.Sprintf("%s: %v", command, err)
		return outcome
	}
	outcome.Detail = fmt.Sprintf("blocked %s at the host firewall", address)
	return outcome
}

// firewallCommand is the platform's way to drop an address, stated once.
func firewallCommand(goos, address string) (string, []string, error) {
	switch goos {
	case "linux":
		return "iptables", []string{"-I", "INPUT", "-s", address, "-j", "DROP"}, nil
	case "darwin":
		return "pfctl", []string{"-t", "sentinel-block", "-T", "add", address}, nil
	case "windows":
		return "netsh", []string{"advfirewall", "firewall", "add", "rule", "name=SentinelBlock", "dir=in", "action=block", "remoteip=" + address}, nil
	default:
		return "", nil, fmt.Errorf("no host firewall adapter for %s", goos)
	}
}

func processName(detection detect.Detection) string {
	if detection.Process == "" {
		return "process"
	}
	return detection.Process
}
