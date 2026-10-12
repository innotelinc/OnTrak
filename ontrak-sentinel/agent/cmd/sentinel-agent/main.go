// Command sentinel-agent is a Sentinel Guard sensor and responder for one host.
//
// It reads the host's own state (connections and processes), judges it against the host
// signatures, acts on what the deployment's posture says to act on without asking, and ships
// every observation to Guard so the pipeline can correlate it with identity and everything else.
//
// Configuration is all environment:
//
//	SENTINEL_BASE_URL            the deployment root (or SENTINEL_ISSUER)
//	SENTINEL_GUARD_TOKEN         the ingest token; without it the agent will not start
//	SENTINEL_GUARD_ORGANIZATION  the tenant slug (empty for a pinned deployment)
//	SENTINEL_AGENT_SENSOR        this host's name (default: the machine's hostname)
//	SENTINEL_AGENT_SOURCE        the telemetry source (default: EDR)
//	SENTINEL_AGENT_INTERVAL_SECONDS  how often to take a snapshot (default: 30)
//	SENTINEL_AGENT_ENFORCE       `1` to actually kill processes and edit the firewall
//	SENTINEL_AGENT_ONCE          `1` to run one cycle and exit (a smoke test)
//
// **Enforcement is off by default.** The agent still detects, still logs what it would do, and
// still ships the telemetry that raises the alert; it just does not change the host until a
// deployment says so. Turning it on is the one switch that makes it autonomous.
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"sentinel-agent/internal/agent"
	"sentinel-agent/internal/collect"
	"sentinel-agent/internal/guard"
	"sentinel-agent/internal/respond"
)

func env(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok && strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return fallback
}

func envBool(key string) bool { return env(key, "") == "1" }

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	log.SetPrefix("[sentinel-agent] ")

	baseURL := env("SENTINEL_BASE_URL", env("SENTINEL_ISSUER", ""))
	token := env("SENTINEL_GUARD_TOKEN", "")
	if baseURL == "" || token == "" {
		log.Fatal("SENTINEL_BASE_URL (or SENTINEL_ISSUER) and SENTINEL_GUARD_TOKEN are required")
	}

	hostname, err := os.Hostname()
	if err != nil {
		hostname = "unknown-host"
	}
	sensor := env("SENTINEL_AGENT_SENSOR", hostname)
	source := env("SENTINEL_AGENT_SOURCE", "EDR")
	intervalSeconds, err := strconv.Atoi(env("SENTINEL_AGENT_INTERVAL_SECONDS", "30"))
	if err != nil || intervalSeconds < 1 {
		intervalSeconds = 30
	}
	enforce := envBool("SENTINEL_AGENT_ENFORCE")
	once := envBool("SENTINEL_AGENT_ONCE")

	client := guard.New(baseURL, token, env("SENTINEL_GUARD_ORGANIZATION", ""), sensor, source)
	responder := respond.New(!enforce)
	runner := &agent.Agent{
		Collector: collect.New(sensor),
		Sender:    client,
		Actor:     responder,
		Logf:      log.Printf,
	}

	log.Printf("watching this host as %q, shipping to %s as %q", sensor, baseURL+guard.EventsPath, source)
	if enforce {
		log.Printf("enforcement is ON: autonomous high/medium detections will kill processes and edit the host firewall")
	} else {
		log.Printf("enforcement is OFF (dry run): detections are logged and shipped but the host is not changed. Set SENTINEL_AGENT_ENFORCE=1 to act.")
	}

	run := func(ctx context.Context) {
		cycle := runner.Run(ctx, time.Now())
		if cycle.Err != nil {
			log.Printf("cycle finished with an error: %v", cycle.Err)
		}
	}

	if once {
		run(context.Background())
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	interval := time.Duration(intervalSeconds) * time.Second
	log.Printf("snapshotting every %s; send SIGINT/SIGTERM to stop", interval)

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	run(ctx)
	for {
		select {
		case <-ctx.Done():
			log.Print("stopping")
			return
		case <-ticker.C:
			run(ctx)
		}
	}
}
