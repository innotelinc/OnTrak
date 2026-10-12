// Package agent is the run loop: read the host, judge it locally, act on what the policy says to
// act on, and ship everything to Guard.
//
// The loop is written against three interfaces — a collector, an actor and a sender — so the one
// decision that matters, *which detections are acted on without asking*, is a unit test with
// fakes. Everything else in the product can be replaced around it; this is the seam.
package agent

import (
	"context"
	"time"

	"sentinel-agent/internal/detect"
	"sentinel-agent/internal/guard"
	"sentinel-agent/internal/model"
	"sentinel-agent/internal/respond"
)

// Collector reads the host's current state.
type Collector interface {
	Snapshot(ctx context.Context, now time.Time) ([]model.Event, error)
}

// Sender ships a batch to Guard.
type Sender interface {
	Send(ctx context.Context, events []model.Event) (guard.Report, error)
}

// Actor carries out a detection's action.
type Actor interface {
	Act(ctx context.Context, detection detect.Detection) respond.Outcome
}

// Agent is one monitored host.
type Agent struct {
	Collector Collector
	Sender    Sender
	Actor     Actor
	// Detect is the judgement, defaulting to the shipped host signatures. Injectable so the
	// autonomy gate can be tested with a quiet detection the shipped rules never produce.
	Detect func(events []model.Event) []detect.Detection
	// Logf is where the agent says what it did. Never contains credentials.
	Logf func(format string, args ...any)
}

// Cycle is what one pass produced, whether or not it succeeded.
type Cycle struct {
	Events     int
	Detections []detect.Detection
	// Outcomes are the actions actually attempted: the autonomous ones only.
	Outcomes []respond.Outcome
	// Missed are detections too quiet to act on, shipped for a person to see.
	Missed []detect.Detection
	Report guard.Report
	Err    error
}

// Run performs one pass.
//
// Ordering is deliberate: act *first*, ship second. A host action taken in the second the threat
// is seen is the point of an agent; the telemetry that explains it can follow. A failed send does
// not undo an action — it is reported in `Err` so the caller can retry the send, which is why the
// caller logs rather than the loop swallowing it.
func (a *Agent) Run(ctx context.Context, now time.Time) Cycle {
	cycle := Cycle{}
	logf := a.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}

	events, err := a.Collector.Snapshot(ctx, now)
	if err != nil {
		cycle.Err = err
		return cycle
	}
	cycle.Events = len(events)

	detectFn := a.Detect
	if detectFn == nil {
		detectFn = detect.Evaluate
	}
	detections := detectFn(events)
	cycle.Detections = detections
	for _, detection := range detections {
		if !detect.Autonomous(detection.Severity) {
			cycle.Missed = append(cycle.Missed, detection)
			continue
		}
		outcome := a.Actor.Act(ctx, detection)
		cycle.Outcomes = append(cycle.Outcomes, outcome)
		logf("[agent] %s %s: %s%s", detection.Severity, detection.RuleID, outcome.Detail, errorSuffix(outcome.Err))
	}

	if len(events) > 0 {
		report, sendErr := a.Sender.Send(ctx, events)
		cycle.Report = report
		if sendErr != nil {
			cycle.Err = sendErr
			logf("[agent] telemetry send failed: %v", sendErr)
		} else {
			logf("[agent] shipped %d event(s); the server raised %d alert(s)", report.Accepted, len(report.Alerts))
		}
	}
	return cycle
}

func errorSuffix(err string) string {
	if err == "" {
		return ""
	}
	return " — FAILED: " + err
}
