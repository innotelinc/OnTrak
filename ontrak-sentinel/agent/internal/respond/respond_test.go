package respond

import (
	"context"
	"errors"
	"runtime"
	"strings"
	"testing"

	"sentinel-agent/internal/detect"
)

func responder(dryRun bool) (*Responder, *[]string, *[]int) {
	var execs []string
	var kills []int
	r := New(dryRun)
	r.Exec = func(_ context.Context, name string, args ...string) error {
		execs = append(execs, name+" "+strings.Join(args, " "))
		return nil
	}
	r.Kill = func(pid int) error {
		kills = append(kills, pid)
		return nil
	}
	return r, &execs, &kills
}

func TestKillIsSuppressedByDryRun(t *testing.T) {
	r, _, kills := responder(true)
	outcome := r.Act(context.Background(), detect.Detection{RuleID: "SG-HOST-001", Action: detect.ActionKill, Process: "mimikatz.exe", PID: 99})

	if !outcome.OK() {
		t.Fatalf("dry run should be ok, got %+v", outcome)
	}
	if len(*kills) != 0 {
		t.Fatal("dry run must not kill anything")
	}
	if !strings.Contains(outcome.Detail, "would kill") || !strings.Contains(outcome.Detail, "99") {
		t.Fatalf("dry run detail = %q", outcome.Detail)
	}
}

func TestKillRunsWhenEnforcing(t *testing.T) {
	r, _, kills := responder(false)
	outcome := r.Act(context.Background(), detect.Detection{RuleID: "SG-HOST-001", Action: detect.ActionKill, Process: "mimikatz.exe", PID: 1234})

	if !outcome.OK() || len(*kills) != 1 || (*kills)[0] != 1234 {
		t.Fatalf("expected a kill of 1234, got %+v / kills %v", outcome, *kills)
	}
}

func TestKillFailureIsReportedNotThrown(t *testing.T) {
	r, _, _ := responder(false)
	r.Kill = func(int) error { return errors.New("operation not permitted") }
	outcome := r.Act(context.Background(), detect.Detection{Action: detect.ActionKill, PID: 5})

	if outcome.OK() || !strings.Contains(outcome.Err, "not permitted") {
		t.Fatalf("a failed kill must be reported, got %+v", outcome)
	}
}

func TestKillWithoutAPidDoesNothing(t *testing.T) {
	r, _, kills := responder(false)
	outcome := r.Act(context.Background(), detect.Detection{Action: detect.ActionKill})
	if !outcome.OK() || len(*kills) != 0 {
		t.Fatalf("a kill with no pid must be a no-op, got %+v", outcome)
	}
}

func TestMonitorAndQuarantineChangeNothing(t *testing.T) {
	r, execs, kills := responder(false)
	monitor := r.Act(context.Background(), detect.Detection{Action: detect.ActionMonitor})
	quarantine := r.Act(context.Background(), detect.Detection{Action: detect.ActionQuarantine})
	if !monitor.OK() || !quarantine.OK() {
		t.Fatalf("monitor/quarantine should be ok, got %+v / %+v", monitor, quarantine)
	}
	if len(*execs) != 0 || len(*kills) != 0 {
		t.Fatal("monitor and quarantine must not touch the host")
	}
}

func TestBlockRunsTheHostFirewallWhenEnforcing(t *testing.T) {
	r, execs, _ := responder(false)
	outcome := r.Act(context.Background(), detect.Detection{Action: detect.ActionBlock, Address: "203.0.113.9"})
	if !outcome.OK() || len(*execs) != 1 {
		t.Fatalf("expected one firewall command, got %+v / %v", outcome, *execs)
	}
	if runtime.GOOS == "linux" && !strings.HasPrefix((*execs)[0], "iptables ") {
		t.Fatalf("linux should block with iptables, got %q", (*execs)[0])
	}
	if !strings.Contains((*execs)[0], "203.0.113.9") {
		t.Fatalf("the address must reach the firewall, got %q", (*execs)[0])
	}
}

func TestBlockIsSuppressedByDryRunAndRefusesWithoutAnAddress(t *testing.T) {
	r, execs, _ := responder(true)
	dry := r.Act(context.Background(), detect.Detection{Action: detect.ActionBlock, Address: "203.0.113.9"})
	if !dry.OK() || len(*execs) != 0 || !strings.Contains(dry.Detail, "would run") {
		t.Fatalf("dry-run block should not exec, got %+v / %v", dry, *execs)
	}

	empty := r.Act(context.Background(), detect.Detection{Action: detect.ActionBlock})
	if empty.OK() || !strings.Contains(empty.Err, "no address") {
		t.Fatalf("a block with no address must be refused, got %+v", empty)
	}
}
