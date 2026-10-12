package agent

import (
	"context"
	"errors"
	"testing"
	"time"

	"sentinel-agent/internal/detect"
	"sentinel-agent/internal/guard"
	"sentinel-agent/internal/model"
	"sentinel-agent/internal/respond"
)

type fakeCollector struct {
	events []model.Event
	err    error
}

func (f fakeCollector) Snapshot(context.Context, time.Time) ([]model.Event, error) {
	return f.events, f.err
}

type fakeSender struct {
	sent   []model.Event
	report guard.Report
	err    error
}

func (f *fakeSender) Send(_ context.Context, events []model.Event) (guard.Report, error) {
	f.sent = events
	return f.report, f.err
}

type fakeActor struct{ acted []detect.Detection }

func (f *fakeActor) Act(_ context.Context, d detect.Detection) respond.Outcome {
	f.acted = append(f.acted, d)
	return respond.Outcome{RuleID: d.RuleID, Action: d.Action, Detail: "acted"}
}

func TestRunActsOnlyOnAutonomousDetectionsAndShipsEverything(t *testing.T) {
	actor := &fakeActor{}
	sender := &fakeSender{report: guard.Report{Accepted: 2}}
	a := &Agent{
		Collector: fakeCollector{events: []model.Event{{Process: "x"}, {Process: "y"}}},
		Sender:    sender,
		Actor:     actor,
		Detect: func([]model.Event) []detect.Detection {
			return []detect.Detection{
				{RuleID: "SG-HOST-001", Severity: detect.SeverityCritical, Action: detect.ActionKill, PID: 1},
				{RuleID: "SG-HOST-999", Severity: detect.SeverityLow, Action: detect.ActionMonitor},
			}
		},
	}

	cycle := a.Run(context.Background(), time.Now())

	if len(actor.acted) != 1 || actor.acted[0].RuleID != "SG-HOST-001" {
		t.Fatalf("only the autonomous detection should be acted on, got %+v", actor.acted)
	}
	if len(cycle.Missed) != 1 || cycle.Missed[0].RuleID != "SG-HOST-999" {
		t.Fatalf("the quiet detection should be reported as missed, got %+v", cycle.Missed)
	}
	if len(sender.sent) != 2 {
		t.Fatalf("every event should be shipped regardless of action, got %d", len(sender.sent))
	}
	if cycle.Report.Accepted != 2 || cycle.Events != 2 {
		t.Fatalf("cycle = %+v", cycle)
	}
}

func TestRunReportsCollectorAndSenderFailuresWithoutPanicking(t *testing.T) {
	collectErr := &Agent{Collector: fakeCollector{err: errors.New("no proc")}, Sender: &fakeSender{}, Actor: &fakeActor{}}
	if cycle := collectErr.Run(context.Background(), time.Now()); cycle.Err == nil {
		t.Fatal("a collector error must surface")
	}

	sendErr := &Agent{
		Collector: fakeCollector{events: []model.Event{{Process: "x"}}},
		Sender:    &fakeSender{err: errors.New("down")},
		Actor:     &fakeActor{},
	}
	if cycle := sendErr.Run(context.Background(), time.Now()); cycle.Err == nil {
		t.Fatal("a send error must surface, because the caller retries the send")
	}
}

func TestRunSendsNothingWhenThereIsNoTelemetry(t *testing.T) {
	sender := &fakeSender{}
	a := &Agent{Collector: fakeCollector{}, Sender: sender, Actor: &fakeActor{}}
	cycle := a.Run(context.Background(), time.Now())
	if cycle.Events != 0 || len(sender.sent) != 0 {
		t.Fatalf("an empty snapshot should send nothing, got %+v", cycle)
	}
}
