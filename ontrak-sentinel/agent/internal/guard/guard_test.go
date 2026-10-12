package guard

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"sentinel-agent/internal/model"
)

func TestSendPostsTheBatchWithAuthAndTenant(t *testing.T) {
	var gotBatch model.Batch
	var gotAuth, gotOrg, gotContentType string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != EventsPath {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		gotAuth = r.Header.Get("authorization")
		gotOrg = r.Header.Get("x-sentinel-organization")
		gotContentType = r.Header.Get("content-type")
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &gotBatch)
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"accepted":1,"alerts":[{"id":"a1","ruleId":"SG-HOST-001","severity":"CRITICAL","created":true}]}`))
	}))
	defer server.Close()

	client := New(server.URL, "guard-secret", "demo", "host-01", "EDR")
	report, err := client.Send(context.Background(), []model.Event{{Kind: model.KindHost, Process: "mimikatz.exe"}})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	if gotAuth != "Bearer guard-secret" {
		t.Fatalf("authorization header = %q", gotAuth)
	}
	if gotOrg != "demo" {
		t.Fatalf("tenant header = %q", gotOrg)
	}
	if gotContentType != "application/json" {
		t.Fatalf("content-type = %q", gotContentType)
	}
	if gotBatch.Source != "EDR" || gotBatch.Sensor != "host-01" || len(gotBatch.Events) != 1 {
		t.Fatalf("batch = %+v", gotBatch)
	}
	if len(report.Alerts) != 1 || report.Alerts[0].RuleID != "SG-HOST-001" || !report.Alerts[0].Created {
		t.Fatalf("report = %+v", report)
	}
}

func TestSendOmitsTenantHeaderWhenUnset(t *testing.T) {
	var present bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, present = r.Header["X-Sentinel-Organization"]
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"accepted":1}`))
	}))
	defer server.Close()

	if _, err := New(server.URL, "t", "", "h", "EDR").Send(context.Background(), nil); err != nil {
		t.Fatalf("send: %v", err)
	}
	if present {
		t.Fatal("a pinned deployment must not be sent an empty tenant header")
	}
}

func TestSendReportsRefusalRatherThanSwallowing(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"invalid_token"}`))
	}))
	defer server.Close()

	_, err := New(server.URL, "wrong", "demo", "h", "EDR").Send(context.Background(), nil)
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("expected a 401 error, got %v", err)
	}
}

func TestSendRefusesWithoutConfiguration(t *testing.T) {
	if _, err := New("", "t", "", "h", "EDR").Send(context.Background(), nil); err == nil {
		t.Fatal("a missing base URL must be an error, not a silent no-op")
	}
	if _, err := New("http://example.test", "", "", "h", "EDR").Send(context.Background(), nil); err == nil {
		t.Fatal("a missing token must be an error, not a silent no-op")
	}
}
