package collect

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A real /proc/net/tcp header and two rows: an established connection to 10.0.0.5:443 and a
// listener on 0.0.0.0:22 (little-endian hex addresses).
const procNetTCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 0500000A:01BB 01 00000000:00000000 02:00000000 00000000  1000 0 12345 1 0000000000000000 20 4 30 10 -1
   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000  0 0 67890 1 0000000000000000 100 0 0 10 0
   2: nonsense
`

func TestParseProcNetTCP(t *testing.T) {
	at := time.UnixMilli(1_700_000_000_000)
	events, err := ParseProcNetTCP(strings.NewReader(procNetTCP), "host-01", at)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("expected 2 events (one connection, one listener), got %d: %+v", len(events), events)
	}

	established := events[0]
	if established.Direction != "OUTBOUND" || established.DestinationAddress != "10.0.0.5" || established.DestinationPort != 443 {
		t.Fatalf("established row decoded wrong: %+v", established)
	}
	if established.SourceAddress != "127.0.0.1" || established.SourcePort != 8080 {
		t.Fatalf("local side decoded wrong: %+v", established)
	}
	if established.At != at.UnixMilli() || established.Kind != "NETWORK" {
		t.Fatalf("event metadata wrong: %+v", established)
	}

	listener := events[1]
	if listener.Direction != "INBOUND" || listener.DestinationPort != 22 {
		t.Fatalf("listener row decoded wrong: %+v", listener)
	}
	if listener.SourceAddress != "host-01" {
		t.Fatalf("a wildcard bind should be stamped with the host, got %q", listener.SourceAddress)
	}
}

func TestParseProcStatus(t *testing.T) {
	status := "Name:\tbash\nUid:\t1000\t1000\t1000\t1000\nPPid:\t42\n"
	ppid, uid, err := ParseProcStatus(strings.NewReader(status))
	if err != nil || ppid != 42 || uid != 1000 {
		t.Fatalf("status decoded wrong: ppid=%d uid=%d err=%v", ppid, uid, err)
	}
}

func TestLinuxSnapshotterReadsAProcTree(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "net"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "net", "tcp"), []byte(procNetTCP), 0o644); err != nil {
		t.Fatal(err)
	}
	// pid 7 is a shell whose parent 3 is a web server.
	writeFixture(t, filepath.Join(root, "7", "comm"), "bash\n")
	writeFixture(t, filepath.Join(root, "7", "status"), "Name:\tbash\nUid:\t0\nPPid:\t3\n")
	writeFixture(t, filepath.Join(root, "3", "comm"), "nginx\n")
	writeFixture(t, filepath.Join(root, "3", "status"), "Name:\tnginx\nUid:\t0\nPPid:\t1\n")

	snapshotter := &LinuxSnapshotter{ProcRoot: root, Host: "host-01"}
	events, err := snapshotter.Snapshot(context.Background(), time.UnixMilli(1_700_000_000_000))
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}

	var shellFound bool
	for _, event := range events {
		if event.Kind == "HOST" && event.Process == "bash" {
			shellFound = true
			if event.ParentProcess != "nginx" {
				t.Fatalf("the parent name must be resolved, got %q", event.ParentProcess)
			}
			if event.PID != 7 {
				t.Fatalf("the pid must be the process's, got %d", event.PID)
			}
		}
	}
	if !shellFound {
		t.Fatalf("expected a HOST event for bash, got %+v", events)
	}
	if len(events) < 4 {
		t.Fatalf("expected two connections and two processes, got %d", len(events))
	}
}

func writeFixture(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
