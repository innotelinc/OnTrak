package detect

import (
	"testing"

	"sentinel-agent/internal/model"
)

func TestCredentialDumperMatchesRegardlessOfPathOrCase(t *testing.T) {
	cases := []string{`C:\Tools\Mimikatz.exe`, "mimikatz", "/opt/impacket/secretsdump.py", "PROCDUMP.EXE"}
	for _, process := range cases {
		found := Evaluate([]model.Event{{Process: process, PID: 4242}})
		if len(found) != 1 || found[0].RuleID != "SG-HOST-001" {
			t.Fatalf("expected SG-HOST-001 for %q, got %+v", process, found)
		}
		if found[0].Severity != SeverityCritical || found[0].Action != ActionKill {
			t.Fatalf("credential dumping must be critical and killed, got %+v", found[0])
		}
		if found[0].PID != 4242 {
			t.Fatalf("the detection must carry the pid to act on, got %d", found[0].PID)
		}
	}
}

func TestBenignProcessIsNotDetected(t *testing.T) {
	found := Evaluate([]model.Event{{Process: "explorer.exe"}, {Process: "/usr/bin/systemd"}, {}})
	if len(found) != 0 {
		t.Fatalf("expected no detections, got %+v", found)
	}
}

func TestWebServerShellNeedsBothHalves(t *testing.T) {
	matched := Evaluate([]model.Event{{Process: "bash", ParentProcess: "/usr/sbin/nginx", PID: 7}})
	if len(matched) != 1 || matched[0].RuleID != "SG-HOST-002" || matched[0].Severity != SeverityHigh {
		t.Fatalf("expected a high SG-HOST-002, got %+v", matched)
	}

	// A shell whose parent is sshd is a person at a terminal, not a dropped web shell.
	if found := Evaluate([]model.Event{{Process: "bash", ParentProcess: "sshd"}}); len(found) != 0 {
		t.Fatalf("a shell from sshd must not match, got %+v", found)
	}
	// And a web server alone is not an incident.
	if found := Evaluate([]model.Event{{Process: "nginx"}}); len(found) != 0 {
		t.Fatalf("nginx by itself must not match, got %+v", found)
	}
}

func TestPersistenceEventMatches(t *testing.T) {
	found := Evaluate([]model.Event{{Process: "schtasks.exe", EventType: "scheduled_task_created"}})
	if len(found) != 1 || found[0].RuleID != "SG-HOST-003" || found[0].Action != ActionQuarantine {
		t.Fatalf("expected a quarantine SG-HOST-003, got %+v", found)
	}
	if found := Evaluate([]model.Event{{EventType: "something_else"}}); len(found) != 0 {
		t.Fatalf("an unknown event type must not match, got %+v", found)
	}
}

func TestAutonomyIsMediumAndAbove(t *testing.T) {
	autonomous := []Severity{SeverityMedium, SeverityHigh, SeverityCritical}
	for _, severity := range autonomous {
		if !Autonomous(severity) {
			t.Fatalf("%s should be acted on autonomously", severity)
		}
	}
	if Autonomous(SeverityLow) {
		t.Fatal("LOW must be observed, not acted on")
	}
	if Autonomous("") {
		t.Fatal("an unknown severity must not be treated as autonomous")
	}
}
