// Package collect turns the host's own state into observations.
//
// The parser functions are pure and take a reader, which is the whole trick that makes endpoint
// telemetry testable: `/proc/net/tcp` and `/proc/<pid>/status` are just text, so their decoders
// are driven with fixtures rather than with a live kernel, and the only untested part is the
// three lines that open the file.
//
// The Linux reader is the reference implementation. The `Snapshotter` interface is the seam a
// Windows or macOS collector slots into without touching detection, response or the loop — the
// same shape the server uses for its own vendor adapters.
package collect

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"sentinel-agent/internal/model"
)

// Snapshotter reads the host's current state as observations.
type Snapshotter interface {
	Snapshot(ctx context.Context, now time.Time) ([]model.Event, error)
}

// New returns the collector for the platform this binary runs on.
//
// Linux is the reference implementation. Windows and macOS cross-compile and run — the agent,
// the response actions and the Guard client are all portable — but their *collectors* are the
// next increment, and until they exist this returns a collector that says so rather than one
// that silently reports an empty host. An empty snapshot reads as "nothing happened", which is
// the one thing an agent must never say when it simply cannot see.
func New(host string) Snapshotter {
	if runtime.GOOS == "linux" {
		return NewLinux(host)
	}
	return Unsupported{Platform: runtime.GOOS}
}

// Unsupported is the honest collector for a platform whose reader is not built yet.
type Unsupported struct{ Platform string }

// Snapshot answers with a reason rather than with no events.
func (u Unsupported) Snapshot(context.Context, time.Time) ([]model.Event, error) {
	return nil, fmt.Errorf("no host collector for %s yet — see agent/README.md; detection, response and ingest are ready, only the platform reader is missing", u.Platform)
}

// ParseProcNetTCP decodes `/proc/net/tcp` (or `tcp6`) into connection events.
//
// Each row is `sl local_address rem_address st …`, addresses as `HEXIP:HEXPORT` in network byte
// order. An established socket (`st 01`) becomes an OUTBOUND observation; a listener (`st 0A`)
// becomes an INBOUND one carrying the local port, which is what the listening-port anomaly
// watches. Rows the format does not describe are skipped rather than guessed at.
func ParseProcNetTCP(r io.Reader, host string, at time.Time) ([]model.Event, error) {
	var events []model.Event
	scanner := bufio.NewScanner(r)
	first := true
	for scanner.Scan() {
		if first {
			// The header row.
			first = false
			continue
		}
		fields := strings.Fields(scanner.Text())
		if len(fields) < 4 {
			continue
		}
		localIP, localPort, err := decodeHexAddress(fields[1])
		if err != nil {
			continue
		}
		remoteIP, remotePort, err := decodeHexAddress(fields[2])
		if err != nil {
			continue
		}
		state := strings.ToUpper(fields[3])
		source := localIP
		if source == "0.0.0.0" && host != "" {
			source = host
		}

		switch state {
		case "01": // ESTABLISHED — an outbound connection as the host reports it.
			events = append(events, model.Event{
				Kind:               model.KindNetwork,
				Source:             "EBPF",
				At:                 at.UnixMilli(),
				Sensor:             host,
				SourceAddress:      source,
				SourcePort:         localPort,
				DestinationAddress: remoteIP,
				DestinationPort:    remotePort,
				Protocol:           "tcp",
				Direction:          model.DirectionOutbound,
			})
		case "0A": // LISTEN — a service accepting connections on this host.
			events = append(events, model.Event{
				Kind:               model.KindNetwork,
				Source:             "EBPF",
				At:                 at.UnixMilli(),
				Sensor:             host,
				SourceAddress:      source,
				DestinationAddress: source,
				DestinationPort:    localPort,
				Protocol:           "tcp",
				Direction:          model.DirectionInbound,
			})
		}
	}
	return events, scanner.Err()
}

// decodeHexAddress turns `0100007F:0035` into `127.0.0.1`, 53.
//
// The address is four hex bytes in little-endian order, which is why the octets are read
// backwards; a string that is not an 8-hex-address and a 4-hex-port is an error, not a guess.
func decodeHexAddress(value string) (string, int, error) {
	ipHex, portHex, ok := strings.Cut(value, ":")
	if !ok || len(ipHex) != 8 || len(portHex) != 4 {
		return "", 0, fmt.Errorf("not a proc address: %q", value)
	}
	octets := make([]string, 4)
	for i := 0; i < 4; i++ {
		byteValue, err := strconv.ParseUint(ipHex[i*2:i*2+2], 16, 8)
		if err != nil {
			return "", 0, err
		}
		octets[3-i] = strconv.Itoa(int(byteValue))
	}
	port, err := strconv.ParseUint(portHex, 16, 16)
	if err != nil {
		return "", 0, err
	}
	return strings.Join(octets, "."), int(port), nil
}

// ParseProcStatus reads the parent pid and the real uid out of `/proc/<pid>/status`.
func ParseProcStatus(r io.Reader) (ppid int, uid int, err error) {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "PPid:"):
			ppid, _ = strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "PPid:")))
		case strings.HasPrefix(line, "Uid:"):
			fields := strings.Fields(strings.TrimPrefix(line, "Uid:"))
			if len(fields) > 0 {
				uid, _ = strconv.Atoi(fields[0])
			}
		}
	}
	return ppid, uid, scanner.Err()
}

// LinuxSnapshotter reads `/proc` as the reference collector.
type LinuxSnapshotter struct {
	// ProcRoot is `/proc` in production; a fixture directory in tests.
	ProcRoot string
	// Host is this machine's address or name, stamped on host observations.
	Host string
	// MaxProcesses bounds one scan, so a fork bomb cannot make the agent the problem.
	MaxProcesses int
}

// NewLinux builds the reference collector.
func NewLinux(host string) *LinuxSnapshotter {
	return &LinuxSnapshotter{ProcRoot: "/proc", Host: host, MaxProcesses: 4096}
}

// Snapshot reads connections and processes into one batch of observations.
func (s *LinuxSnapshotter) Snapshot(ctx context.Context, now time.Time) ([]model.Event, error) {
	root := s.ProcRoot
	if root == "" {
		root = "/proc"
	}

	var events []model.Event
	if file, err := os.Open(filepath.Join(root, "net", "tcp")); err == nil {
		connectionEvents, parseErr := ParseProcNetTCP(file, s.Host, now)
		file.Close()
		if parseErr != nil {
			return nil, parseErr
		}
		events = append(events, connectionEvents...)
	}

	processEvents, err := s.processes(ctx, root, now)
	if err != nil {
		return nil, err
	}
	return append(events, processEvents...), nil
}

// processes enumerates running processes, resolving each one's parent name.
func (s *LinuxSnapshotter) processes(ctx context.Context, root string, now time.Time) ([]model.Event, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}

	max := s.MaxProcesses
	if max <= 0 {
		max = 4096
	}
	names := map[string]string{}
	var candidates []string

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pid := entry.Name()
		if _, err := strconv.Atoi(pid); err != nil {
			continue // not a pid directory
		}
		if len(candidates) >= max {
			break
		}
		if raw, err := os.ReadFile(filepath.Join(root, pid, "comm")); err == nil {
			names[pid] = strings.TrimSpace(string(raw))
		}
		candidates = append(candidates, pid)
	}
	_ = ctx

	var events []model.Event
	for _, pid := range candidates {
		statusPath := filepath.Join(root, pid, "status")
		file, err := os.Open(statusPath)
		if err != nil {
			continue
		}
		ppid, _, statusErr := ParseProcStatus(file)
		file.Close()
		if statusErr != nil {
			continue
		}
		events = append(events, model.Event{
			Kind:               model.KindHost,
			Source:             "EDR",
			At:                 now.UnixMilli(),
			Sensor:             s.Host,
			SourceAddress:      s.Host,
			DestinationAddress: s.Host,
			Process:            names[pid],
			ParentProcess:      names[strconv.Itoa(ppid)],
			PID:                atoiOrZero(pid),
		})
	}
	return events, nil
}

func atoiOrZero(value string) int {
	n, err := strconv.Atoi(value)
	if err != nil {
		return 0
	}
	return n
}
