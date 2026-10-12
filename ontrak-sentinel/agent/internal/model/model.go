// Package model is the one record the agent emits, in the shape Sentinel Guard's normalizer
// already reads.
//
// The agent does not invent a vocabulary. Every field here maps to a key the Go normalizer in
// `ontrak-sentinel/src/lib/telemetry-rules.ts` picks up: the addresses, the ports, the
// direction, and the extra facts (`process`, `parentProcess`, `event`, `path`) that land in the
// normalizer's `attributes` map and that the host rules match on. Keeping the wire shape in one
// small struct is what stops the agent and the server drifting into two opinions about what a
// host observation is.
package model

// Telemetry kinds the agent reports. Host observations are HOST by default; a network
// connection the agent sees locally is NETWORK; a proxy-style HTTP fact is HTTP.
const (
	KindHost    = "HOST"
	KindNetwork = "NETWORK"
	KindHTTP    = "HTTP"
)

// Direction, in the vocabulary the normalizer accepts. The agent states it rather than leaving
// it to be inferred, because "port 22" means opposite things in a connection and a listen.
const (
	DirectionInbound  = "INBOUND"
	DirectionOutbound = "OUTBOUND"
	DirectionLateral  = "LATERAL"
)

// Event is one observation, JSON-encoded top-level for `POST /guard/v1/events`.
//
// Optional fields use `omitempty` and zero values rather than pointers, so an absent port is
// absent on the wire and the normalizer's `parsePort` sees nothing to misread. `At` is epoch
// *milliseconds*; the normalizer decides seconds versus milliseconds by magnitude, so sending
// milliseconds is unambiguous.
type Event struct {
	Kind               string `json:"kind"`
	Source             string `json:"source"`
	At                 int64  `json:"at"`
	Sensor             string `json:"sensor"`
	SourceAddress      string `json:"sourceAddress"`
	DestinationAddress string `json:"destinationAddress"`
	SourcePort         int    `json:"sourcePort,omitempty"`
	DestinationPort    int    `json:"destinationPort,omitempty"`
	Protocol           string `json:"protocol,omitempty"`
	Direction          string `json:"direction,omitempty"`

	// The facts host rules match on. Each is a top-level key so the normalizer keeps it in
	// `attributes`; a nested object would be dropped, because attributes are scalars.
	Process       string `json:"process,omitempty"`
	ParentProcess string `json:"parentProcess,omitempty"`
	PID           int    `json:"pid,omitempty"`
	User          string `json:"user,omitempty"`
	CommandLine   string `json:"commandLine,omitempty"`
	EventType     string `json:"event,omitempty"`
	Path          string `json:"path,omitempty"`
	Host          string `json:"host,omitempty"`
}

// Batch is one POST body: a source, a sensor, and the events it is reporting.
type Batch struct {
	Source string  `json:"source"`
	Sensor string  `json:"sensor"`
	Events []Event `json:"events"`
}
