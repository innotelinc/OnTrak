// Package detect is the agent's *local* judgement: a small, deterministic set of host
// signatures, evaluated on the endpoint so the agent can act in the second it takes to notice
// something rather than the round trip it takes to ask the server.
//
// Two things are deliberate:
//
//   - **The rule ids are the server's.** `SG-HOST-001` means the same thing here and in
//     `ontrak-sentinel/src/lib/detection-rules.ts`, so an action the agent took and an alert
//     the pipeline raised can be read as the same incident. The agent does not invent a second
//     numbering for the same idea.
//   - **The policy is data, and conservative.** Everything here can be evaluated from the
//     observed events with no clock, no filesystem and no network, so "why did the agent act?"
//     is a question a test answers by calling `Evaluate`. Autonomy is a property of severity:
//     Medium and above act on their own (the deployment asked for that), Low is observed and
//     shipped but never acted on.
package detect

import (
	"strings"

	"sentinel-agent/internal/model"
)

// Severity, matching the server's vocabulary.
type Severity string

const (
	SeverityLow      Severity = "LOW"
	SeverityMedium   Severity = "MEDIUM"
	SeverityHigh     Severity = "HIGH"
	SeverityCritical Severity = "CRITICAL"
)

// Action is what the responder is asked to do about a detection.
type Action string

const (
	// ActionMonitor ships the detection and changes nothing on the host.
	ActionMonitor Action = "MONITOR"
	// ActionKill ends the offending process.
	ActionKill Action = "KILL"
	// ActionQuarantine moves a file the detection names out of harm's way.
	ActionQuarantine Action = "QUARANTINE"
	// ActionBlock drops traffic to or from an address at the host firewall.
	ActionBlock Action = "BLOCK"
)

// Detection is one local match, with enough to act on and to explain afterwards.
type Detection struct {
	RuleID   string
	RuleName string
	Severity Severity
	Action   Action
	Process  string
	PID      int
	// Address is set for network actions (a block), and empty otherwise.
	Address string
	Detail  string
}

// The severity at which the agent acts without asking. Medium and above, which is the
// deployment's stated posture: low-severity sightings are shipped to the server and left alone.
const AutoApplyAtOrAbove = SeverityMedium

func rank(severity Severity) int {
	switch severity {
	case SeverityLow:
		return 1
	case SeverityMedium:
		return 2
	case SeverityHigh:
		return 3
	case SeverityCritical:
		return 4
	default:
		return 0
	}
}

// Autonomous reports whether this detection is acted on without human approval.
func Autonomous(severity Severity) bool {
	return rank(severity) >= rank(AutoApplyAtOrAbove)
}

// The signature sets. Lower-case base names, because `baseName` normalizes before comparing.
var (
	credentialDumpers = map[string]bool{
		"mimikatz": true, "procdump": true, "secretsdump.py": true, "lazagne": true,
		"gsecdump": true, "pwdump": true, "pwdump7": true, "wce": true, "ntdsutil": true,
		"dsinternals": true,
	}
	shells = map[string]bool{
		"sh": true, "bash": true, "dash": true, "zsh": true, "cmd": true, "powershell": true, "pwsh": true,
	}
	webServers = map[string]bool{
		"nginx": true, "apache2": true, "httpd": true, "w3wp": true, "php-fpm": true,
		"tomcat": true, "node": true, "java": true, "caddy": true,
	}
	persistenceEvents = map[string]bool{
		"scheduled_task_created": true, "startup_entry_added": true, "service_installed": true,
		"authorized_keys_changed": true, "cron_entry_added": true, "persistence": true,
	}
)

// baseName lower-cases a process name and strips any directory and a trailing `.exe`, so
// `/usr/bin/Bash`, `BASH` and `C:\Windows\System32\cmd.exe` each reduce to one comparable name.
func baseName(name string) string {
	lowered := strings.ToLower(strings.TrimSpace(name))
	if index := strings.LastIndexAny(lowered, `/\`); index >= 0 {
		lowered = lowered[index+1:]
	}
	return strings.TrimSuffix(lowered, ".exe")
}

// Evaluate applies the local signatures to a batch of observations.
//
// One detection per matching event, in the order the events arrived. It is deliberately not a
// counter or a window: the host signatures are all "this observation is bad by itself", and the
// platform's threshold and anomaly shapes live server-side, where they can see more than one
// host.
func Evaluate(events []model.Event) []Detection {
	var detections []Detection
	for _, event := range events {
		process := baseName(event.Process)

		if process != "" && credentialDumpers[process] {
			detections = append(detections, Detection{
				RuleID:   "SG-HOST-001",
				RuleName: "Credential-dumping tool executed on a host",
				Severity: SeverityCritical,
				Action:   ActionKill,
				Process:  event.Process,
				PID:      event.PID,
				Detail:   "a tool whose known purpose is to read credentials is running on this host",
			})
		}

		if shells[process] && webServers[baseName(event.ParentProcess)] {
			detections = append(detections, Detection{
				RuleID:   "SG-HOST-002",
				RuleName: "A web-server process spawned a shell",
				Severity: SeverityHigh,
				Action:   ActionKill,
				Process:  event.Process,
				PID:      event.PID,
				Detail:   "a server process (" + baseName(event.ParentProcess) + ") spawned an interactive shell",
			})
		}

		if persistenceEvents[strings.ToLower(strings.TrimSpace(event.EventType))] {
			detections = append(detections, Detection{
				RuleID:   "SG-HOST-003",
				RuleName: "A persistence mechanism was installed on a host",
				Severity: SeverityMedium,
				Action:   ActionQuarantine,
				Process:  event.Process,
				PID:      event.PID,
				Detail:   "a persistence mechanism (" + event.EventType + ") was installed",
			})
		}
	}
	return detections
}
