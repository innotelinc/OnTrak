// Package guard is the agent's one network call: a batch of observations POSTed to Sentinel
// Guard's ingest surface.
//
// It is deliberately thin. The surface already authenticates with a deployment token, files the
// events under a tenant, normalizes them and runs the rulebook — so the agent's job is to send
// honest, correctly-shaped telemetry and to report what the server answered, not to reimplement
// any of it. A batch that the deployment refuses is an error the caller logs; it is never
// swallowed, because silent telemetry loss is how a detection gap becomes a surprise.
package guard

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"sentinel-agent/internal/model"
)

// Alert is one alert the server raised from a batch, as its ingest report carries it.
type Alert struct {
	ID       string `json:"id"`
	RuleID   string `json:"ruleId"`
	Severity string `json:"severity"`
	Created  bool   `json:"created"`
}

// Report is what the ingest surface answered.
type Report struct {
	Accepted int     `json:"accepted"`
	Alerts   []Alert `json:"alerts"`
	Rejected []struct {
		Reason string `json:"reason"`
	} `json:"rejected"`
}

// Client posts batches to one deployment.
type Client struct {
	// BaseURL is the deployment root, e.g. `https://sentinel.ontrak.innotel.us`.
	BaseURL string
	// Token is the deployment's Guard ingest token.
	Token string
	// Organization is the tenant slug; empty leaves the header off for a pinned deployment.
	Organization string
	// Sensor names this host as the sender.
	Sensor string
	// Source is the telemetry source every batch is filed under (`EDR`, `EBPF`, …).
	Source string
	// HTTP is the transport; defaults to a client with a bounded timeout.
	HTTP *http.Client
}

// EventsPath is the ingest endpoint, matching `GUARD_PATHS.events` in the server.
const EventsPath = "/guard/v1/events"

// New builds a client with a sane transport. The timeout is bounded because an agent that blocks
// forever on a down server stops collecting; a refused batch is retried on the next tick.
func New(baseURL, token, organization, sensor, source string) *Client {
	return &Client{
		BaseURL:      strings.TrimRight(baseURL, "/"),
		Token:        strings.TrimSpace(token),
		Organization: strings.TrimSpace(organization),
		Sensor:       sensor,
		Source:       source,
		HTTP:         &http.Client{Timeout: 10 * time.Second},
	}
}

// Send posts one batch and returns the server's report, or an error naming what went wrong.
func (c *Client) Send(ctx context.Context, events []model.Event) (Report, error) {
	var report Report
	if c.BaseURL == "" {
		return report, fmt.Errorf("guard: no base URL configured")
	}
	if c.Token == "" {
		return report, fmt.Errorf("guard: no ingest token configured")
	}

	batch := model.Batch{Source: c.Source, Sensor: c.Sensor, Events: events}
	body, err := json.Marshal(batch)
	if err != nil {
		return report, fmt.Errorf("guard: encode batch: %w", err)
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+EventsPath, bytes.NewReader(body))
	if err != nil {
		return report, fmt.Errorf("guard: build request: %w", err)
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("authorization", "Bearer "+c.Token)
	if c.Organization != "" {
		request.Header.Set("x-sentinel-organization", c.Organization)
	}

	client := c.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		return report, fmt.Errorf("guard: %w", err)
	}
	defer response.Body.Close()

	payload, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return report, fmt.Errorf("guard: ingest answered %d: %s", response.StatusCode, strings.TrimSpace(string(payload)))
	}
	if err := json.Unmarshal(payload, &report); err != nil {
		// A 2xx with an unreadable body still means the server took the batch; say so rather
		// than dropping the events on a decode error.
		return report, fmt.Errorf("guard: accepted but the report could not be read: %w", err)
	}
	return report, nil
}
