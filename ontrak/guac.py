"""Browser console access through Apache Guacamole.

Students never receive an RDP password. The portal hands them a Guacamole URL
whose ``data`` parameter is a signed + encrypted JSON payload (per the
``guacamole-auth-json`` extension), scoped to exactly one connection with a short
expiry. Guacamole verifies the signature, decrypts, and opens the session.

Wire format, exactly as the Guacamole manual specifies:

1. ``signature = HMAC-SHA256(secret, json)`` — 32 raw bytes.
2. Prepend it to the JSON: ``signature || json``.
3. AES-128-CBC encrypt with an all-zero IV (PKCS#7 padding).
4. Base64 the ciphertext; pass as ``data``.

:func:`decode_payload` implements the inverse so the format is testable without
a Guacamole instance.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from urllib.parse import quote, urlparse

from .models import Session
from .scenarios import Scenario

AES_BLOCK = 16
SIGNATURE_LEN = 32

# The value that means "work the console address out from the request that is
# serving the page" rather than from a fixed URL. It is the default because the
# console is a path on the stack's one published port: a range reached at
# `http://192.168.1.9:8080/` (a laptop, a phone hotspot, any LAN) must hand the
# browser a console on that same address, not one on `localhost` — which is the
# browser's own machine and answers nothing. See :func:`resolve_base_url`.
AUTO_BASE_URL = "auto"
CONSOLE_PATH = "/guacamole/"

# How long the gateway probe waits. Generous enough for a TLS handshake on a busy
# host, short enough that `ontrak doctor` does not hang on a name that never answers.
PROBE_TIMEOUT_SECONDS = 8.0


class GuacError(RuntimeError):
    """Raised when a payload cannot be built or read."""


def _aes(key: bytes):
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes  # noqa: PLC0415

    return Cipher(algorithms.AES(key), modes.CBC(b"\x00" * AES_BLOCK))


def _pkcs7():
    from cryptography.hazmat.primitives import padding  # noqa: PLC0415

    return padding.PKCS7(AES_BLOCK * 8)


def encode_payload(payload: dict, key: bytes) -> str:
    """Sign, encrypt and base64 the payload the way guacamole-auth-json expects."""
    if len(key) != AES_BLOCK:
        raise GuacError(f"secret key must be {AES_BLOCK} bytes, got {len(key)}")
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    signature = hmac.new(key, raw, hashlib.sha256).digest()
    blob = signature + raw

    padder = _pkcs7().padder()
    padded = padder.update(blob) + padder.finalize()
    encryptor = _aes(key).encryptor()
    ciphertext = encryptor.update(padded) + encryptor.finalize()
    return base64.b64encode(ciphertext).decode("ascii")


def decode_payload(data: str, key: bytes) -> dict:
    """Inverse of :func:`encode_payload`. Used by tests and for debugging links."""
    try:
        ciphertext = base64.b64decode(data, validate=True)
    except Exception as exc:
        raise GuacError(f"data is not valid base64: {exc}") from exc
    decryptor = _aes(key).decryptor()
    padded = decryptor.update(ciphertext) + decryptor.finalize()
    unpadder = _pkcs7().unpadder()
    try:
        blob = unpadder.update(padded) + unpadder.finalize()
    except ValueError as exc:
        raise GuacError(f"padding is invalid (wrong key?): {exc}") from exc
    if len(blob) <= SIGNATURE_LEN:
        raise GuacError("payload is truncated")
    signature, raw = blob[:SIGNATURE_LEN], blob[SIGNATURE_LEN:]
    expected = hmac.new(key, raw, hashlib.sha256).digest()
    if not hmac.compare_digest(signature, expected):
        raise GuacError("signature does not verify (wrong key or tampered payload)")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise GuacError(f"payload is not valid JSON: {exc}") from exc


def rdp_parameters(settings, session: Session) -> dict:
    """RDP parameters for one student's VM."""
    guac = settings.guac
    params: dict[str, str] = {
        "hostname": session.host_ip,
        "port": str(settings.guest.rdp_port),
        "username": session.rdp_user or settings.guest.user,
        "password": session.rdp_password or settings.guest.password,
        # Windows 10/11 negotiate NLA; "any" lets guacd pick what the host offers
        # while still using the credentials above.
        "security": "any",
        "ignore-cert": "true",
        "resize-method": "display-update",
        "server-layout": guac.server_layout,
        "keyboard-layout": guac.keyboard_layout,
        "color-depth": "32",
        "clipboard-encoding": "UTF-8",
        "disable-audio": "true",
        # Training quality-of-life: keep the guest visually plain so screen
        # sharing and screenshots are readable, and keep transfer off by default.
        "enable-wallpaper": "false",
        "enable-theming": "false",
        "enable-font-smoothing": "true",
        "enable-desktop-composition": "false",
        "disable-bitmap-caching": "false",
        "enable-drive": "false",
        "create-drive-path": "true",
        "autoretry": "5",
    }
    if guac.recording:
        # Session recording for instructor review / incident exercises.
        params.update(
            {
                "recording-path": guac.recording_path,
                "recording-name": (
                    f"ontrak-{session.id}-{session.student}-{session.scenario_id}"
                    "-${GUAC_DATE}-${GUAC_TIME}"
                ),
                "create-recording-path": "true",
            }
        )
    return params


def ssh_parameters(settings, session: Session) -> dict:
    """SSH parameters for one student's Linux guest.

    Used when the Linux guest runs an sshd, which is the shipped default: the
    template build installs one whenever ``guac.linux_ssh`` is on (see
    :func:`sessions.console_transport_script`). A range that turns the setting off
    gets no console at all for its Linux scenarios rather than a connection onto a
    guest with no daemon to answer it.
    """
    guac = settings.guac
    params: dict[str, str] = {
        "hostname": session.host_ip,
        "port": str(settings.guest.ssh_port),
        # The *Linux* account, not the Windows one. `create_session` fills `rdp_user`
        # with `guest.user` (the training account on a Windows guest), while the
        # console transport a Linux template is built with sets the password for
        # `guest.linux_user` (root by default) and nothing else. Borrowing `rdp_user`
        # here pointed every Linux console at an account the image does not have, so
        # guacd's login was refused and the student got a console that never opened.
        "username": settings.guest.linux_user or "root",
        # The password the transport baked into the image: `randomize_credentials`
        # rotates a Windows local account only, so nothing else can move this.
        "password": settings.guest.password,
        "color-depth": "32",
        "font-size": "14",
        "clipboard-encoding": "UTF-8",
        "server-layout": guac.server_layout,
        "read-only": "false",
        "autoretry": "5",
    }
    if guac.recording:
        params.update(
            {
                "recording-path": guac.recording_path,
                "recording-name": (
                    f"ontrak-{session.id}-{session.student}-{session.scenario_id}"
                    "-${GUAC_DATE}-${GUAC_TIME}"
                ),
                "create-recording-path": "true",
            }
        )
    return params


def protocol_for(settings, scenario: Scenario | None) -> str:
    """The console protocol this scenario's guest can actually answer.

    A Windows VM brokers RDP. A Linux *container* does not: it runs no RDP server,
    so an RDP console for it is a page that reports the remote desktop server as
    unreachable, which says nothing about the scenario being broken. It answers SSH
    instead, and that is the shipped default: ``guac.linux_ssh`` is on in
    ``config/ontrak.yaml``, and ``ontrak template build`` puts an sshd in every
    Linux template to match, so a Linux ticket opens a shell with no extra step.
    The setting is the escape hatch for a range whose Linux guests must not open
    port 22 — with it off this returns "" (no browser console), which is the honest
    answer: the portal then explains the situation instead of embedding a console
    that cannot connect.
    """
    # `getattr`, because this runs while a student's session page is being built and
    # the caller only catches GuacError/ScenarioError: a scenario-like object that
    # lacks the property must not turn the page into a 500, and the safe reading of
    # "I cannot tell" is the pre-existing behaviour.
    if scenario is not None and getattr(scenario, "is_linux", False):
        return "ssh" if settings.guac.linux_ssh else ""
    return "rdp"


def connection_name(session: Session, scenario: Scenario | None = None) -> str:
    """The name this session's console connection is signed and listed under.

    One string, in three places at once: the key the portal signs the payload with, the
    name the gateway lists the connection under (what a student sees in the console's
    menu), and — under the JSON auth extension, where a connection's identifier is its
    name — the value the browser sends back as ``GUAC_ID`` when it opens the tunnel.
    """
    title = scenario.title if scenario else session.scenario_id
    return f"OnTrak #{session.id} - {title}"


def build_payload(settings, session: Session, scenario: Scenario | None = None, now: float | None = None) -> dict:
    """Full Guacamole auth payload for one session."""
    if not session.host_ip:
        raise GuacError(f"session {session.id} has no host address yet")
    protocol = protocol_for(settings, scenario)
    if not protocol:
        raise GuacError(
            f"scenario {session.scenario_id} runs a Linux guest, which has no remote "
            "desktop: set guac.linux_ssh once the image runs sshd (guac.ssh_port), "
            "or hand the student a shell another way"
        )
    ttl_seconds = settings.guac.link_ttl_minutes * 60
    expires_ms = int(((now if now is not None else time.time()) + ttl_seconds) * 1000)
    return {
        "username": session.student,
        "expires": expires_ms,
        "connections": {
            connection_name(session, scenario): {
                "id": f"ontrak-session-{session.id}",
                "protocol": protocol,
                "parameters": (
                    ssh_parameters(settings, session) if protocol == "ssh"
                    else rdp_parameters(settings, session)
                ),
            }
        },
    }


def _probe_tls_context():
    """An SSL context that does not verify the gateway's certificate.

    Deliberate, and only for the probes. ``make up`` — the default posture — serves the
    console over TLS with the *local, self-signed* certificate that
    ``scripts/tls-local-cert.sh`` writes, exactly as every browser that opens the range
    is told to accept once. A probe that verified it could therefore never pass on the
    shipped default, and "the console check is broken on every TLS range" is a worse
    failure than this. The probe is not testing confidentiality — it is asking the
    gateway whether it agrees with our signing key, over a connection the operator
    configured.
    """
    import ssl  # noqa: PLC0415 - only the probes need it

    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context


def _post_form(url: str, fields: dict[str, str], timeout: float) -> tuple[int, str]:
    """POST an urlencoded form, exactly as the Guacamole webapp does for a token.

    Kept separate from :func:`probe_gateway` so the interpretation below can be tested
    against a stub, and so the one place that touches the network is this small.
    """
    body = urllib.parse.urlencode(fields).encode("utf-8")
    request = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"}
    )
    try:
        with urllib.request.urlopen(  # noqa: S310 - an operator-set URL
            request, timeout=timeout, context=_probe_tls_context()
        ) as response:
            return int(response.status), response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return int(exc.code), exc.read().decode("utf-8", "replace")


def _get(url: str, timeout: float) -> tuple[int, str]:
    """GET a URL, as :func:`_post_form` does for a form. Same error handling."""
    try:
        with urllib.request.urlopen(  # noqa: S310 - an operator-set URL
            url, timeout=timeout, context=_probe_tls_context()
        ) as response:
            return int(response.status), response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return int(exc.code), exc.read().decode("utf-8", "replace")


# The connection every probe signs. A machine that does not have to exist: the gateway
# answers the *signature* question at token time and only dials a guest when a browser
# opens the console, so a probe can name anything.
PROBE_CONNECTION_NAME = "OnTrak doctor"
PROBE_CONNECTION_ID = "ontrak-doctor"


def _probe_base(settings) -> tuple[str, tuple[str, str] | None]:
    """``(base, skip)``: the gateway URL to probe, or the reason there is none."""
    base = (settings.guac.base_url or "").strip()
    if not base:
        return "", (
            "skipped",
            "guac.base_url is not set, so this range has no console to check",
        )
    if base.lower() == AUTO_BASE_URL:
        # `auto` is a *browser's* address, worked out per request. There is no fixed
        # gateway URL here to POST a token to, and inventing one (localhost) would
        # report on a gateway this host may not even be running. Say that plainly.
        return "", (
            "skipped",
            "guac.base_url is 'auto': the console address is derived from the "
            "browser's own, so there is no fixed gateway URL to probe. Set an "
            "absolute URL to have this check the gateway.",
        )
    return (base if base.endswith("/") else f"{base}/"), None


def _probe_payload(settings, now: float | None = None) -> dict:
    """The payload both probes sign: one connection, one minute, no real guest."""
    return {
        "username": "ontrak-doctor",
        "expires": int(((now if now is not None else time.time()) + 60) * 1000),
        "connections": {
            PROBE_CONNECTION_NAME: {
                "id": PROBE_CONNECTION_ID,
                "protocol": "rdp",
                "parameters": {"hostname": "127.0.0.1", "port": str(settings.guest.rdp_port)},
            }
        },
    }


def _request_token(settings, base: str, payload: dict, timeout: float, post=None):
    """POST a signed payload to the gateway's token endpoint. ``(kind, detail, token)``.

    ``kind`` is one of ``accepted`` / ``refused`` / ``unreachable``, and is the whole
    interpretation of a token request in one place: both probes ask for a token, so a
    second copy of these three answers is how they would come to disagree.
    """
    try:
        key = settings.guac.secret_bytes()
    except Exception as exc:  # noqa: BLE001 - ConfigError's job is to be reported, not raised
        return "skipped", f"guac.secret_key is unusable, so there is no console link to test: {exc}", ""
    sender = post or _post_form
    try:
        status, body = sender(f"{base}api/tokens", {"data": encode_payload(payload, key)}, timeout)
    except (OSError, ValueError) as exc:
        return "unreachable", f"could not reach the console gateway at {base}: {exc}", ""
    if status == 200 and "authToken" in body:
        try:
            token = str(json.loads(body).get("authToken") or "")
        except (ValueError, AttributeError):
            token = ""
        return "accepted", "", token
    if status in (401, 403):
        return "refused", (
            f"the console gateway at {base} rejected a payload signed with guac.secret_key "
            f"(HTTP {status}). Its JSON_SECRET_KEY differs from this key, or its JSON auth "
            "extension is not enabled — so every student's console link is refused and the "
            "console never opens. Make JSON_SECRET_KEY equal ONTRAK_GUAC__SECRET_KEY "
            "(config: guac.secret_key) and recreate the gateway: "
            "`docker compose up -d --force-recreate guacamole`"
        ), ""
    return "unreachable", f"the console gateway at {base} answered HTTP {status}: {body[:200]}", ""


def probe_gateway(settings, *, timeout: float = PROBE_TIMEOUT_SECONDS, post=None):
    """Ask the console gateway whether it accepts a link we signed. ``(state, detail)``.

    Googleable symptom this exists for: **the console iframe never opens**. The portal
    signs every link with ``guac.secret_key`` and Guacamole verifies it with its own
    ``JSON_SECRET_KEY``; when the two disagree — a stack recreated from an older `.env`,
    or a gateway deployed on its own with a freshly generated key — Guacamole answers
    *every* student with "Permission denied". The portal cannot see that: it hands over
    a correctly-signed link, the iframe is blank, and nothing in either log says why.

    States: ``ok`` (accepted), ``refused`` (reached, but rejected our key — a mismatch,
    or the JSON auth extension is off), ``unreachable`` (no answer: split-horizon DNS
    and a stopped gateway are both normal here, so this is a warning), and ``skipped``
    (no console configured at all).
    """
    base, skip = _probe_base(settings)
    if skip is not None:
        return skip
    kind, detail, _token = _request_token(settings, base, _probe_payload(settings), timeout, post)
    if kind == "accepted":
        return "ok", f"the console gateway at {base} accepted a payload signed with guac.secret_key"
    return kind, detail


def _open_connection(
    settings,
    base: str,
    payload: dict,
    timeout: float,
    post=None,
    get=None,
    *,
    name: str = PROBE_CONNECTION_NAME,
) -> tuple[str, str, str, str]:
    """Sign, authenticate and look up the connection a browser would then open.

    ``(kind, detail, token, identifier)``. Both the two probes and the real-session
    check walk these two requests in the browser's own order, so they walk them here,
    once: a second copy is how they would come to disagree about what "listed" means.
    ``kind`` is one of ``accepted`` / ``refused`` / ``unreachable``.
    """
    kind, detail, token = _request_token(settings, base, payload, timeout, post)
    if kind != "accepted":
        return kind, detail, "", ""
    if not token:
        return "unreachable", (
            f"the console gateway at {base} accepted a payload signed with guac.secret_key "
            "but returned no authToken, so there is no session for a browser to open"
        ), "", ""
    url = f"{base}api/session/data/json/connections?token={quote(token, safe='')}"
    reader = get or _get
    try:
        status, body = reader(url, timeout)
    except (OSError, ValueError) as exc:
        return "unreachable", f"could not read the console's connection list from {base}: {exc}", "", ""
    if status != 200:
        return "unreachable", (
            f"the console gateway at {base} accepted the payload but answered HTTP "
            f"{status} for its connection list: {body[:200]}"
        ), "", ""
    identifier = _listed_connection(body, name)
    if not identifier:
        return "refused", (
            f"the console gateway at {base} issued a token but its connection list does "
            f"not contain {name!r}, so a student's freshly signed link opens nothing. "
            "Its JSON auth extension is not registering the payload — check that "
            "JSON_ENABLED is true on the gateway (docker-compose.yml)."
        ), "", ""
    return "accepted", "", token, identifier


def _listed_connection(body: str, name: str) -> str:
    """The identifier the gateway lists ``name`` under, or "".

    Matched on the connection's *name*, which is what a student sees in the console's
    menu and what the portal signs the payload under — that key is also the connection's
    identifier under the JSON auth extension, which is what the tunnel is addressed by.
    """
    try:
        listing = json.loads(body)
    except ValueError:
        return ""
    if not isinstance(listing, dict):
        return ""
    for key, connection in listing.items():
        if not isinstance(connection, dict) or connection.get("name") != name:
            continue
        return str(connection.get("identifier") or key)
    return ""


def probe_console(settings, *, timeout: float = PROBE_TIMEOUT_SECONDS, post=None, get=None):
    """Follow a signed link all the way, the way a browser does. ``(state, detail)``.

    :func:`probe_gateway` answers half the question — does the gateway accept our key?
    — and a range can pass it while still handing students a console that opens nothing:
    a payload the gateway accepts as a *token* can still be missing from the connection
    list the browser then reads, and the student sees an empty console with a healthy
    stack behind it. This is the other half, in the browser's own order:

    1. POST the signed payload to ``api/tokens`` and read the ``authToken`` back.
    2. GET ``api/session/data/json/connections`` with that token — which is exactly what
       the Guacamole webapp does next — and require the connection we signed to be in it.

    That the connection is *listed* is the end-to-end promise: the portal signs one
    connection per session, so a link it just built is a link the console will open.
    The token is left to expire (the payload says one minute) rather than revoked, so
    this stays two requests and one code path.

    :func:`probe_tunnel` is the third and last request; a link that passes this one can
    still fail there.

    Same states as :func:`probe_gateway`: ``ok``, ``refused``, ``unreachable``,
    ``skipped``.
    """
    base, skip = _probe_base(settings)
    if skip is not None:
        return skip
    kind, detail, _token, _identifier = _open_connection(
        settings, base, _probe_payload(settings), timeout, post, get
    )
    if kind != "accepted":
        return kind, detail
    return "ok", (
        f"the console gateway registered {PROBE_CONNECTION_NAME!r} for a freshly signed "
        f"payload and listed it back at {base} — a student's console link opens the "
        "connection this portal signed"
    )


# ---------------------------------------------------------------------------
# the tunnel
#
# The third request a browser makes, and the only one that carries the console:
# after the token and the connection list, `Guacamole.WebSocketTunnel` opens a
# WebSocket to `<base>websocket-tunnel` and speaks the Guacamole protocol over it.
# Everything the *portal* can get wrong is decided by then; everything the *stack* can
# get wrong — a gateway that does not forward `Upgrade`, a webapp with no guacd to talk
# to, an sshd that is not listening — shows up here and nowhere else.
# ---------------------------------------------------------------------------

# The endpoint and query parameters the webapp builds its tunnel from
# (`Guacamole.WebSocketTunnel` for the path and the subprotocol, `ManagedClient` for the
# parameters). Named rather than inlined because they are a wire contract with a browser
# that this repository does not get to change, and because a test pins each of them.
TUNNEL_PATH = "websocket-tunnel"
TUNNEL_SUBPROTOCOL = "guacamole"
TUNNEL_DATA_SOURCE = "json"
TUNNEL_CONNECTION_TYPE = "c"
TUNNEL_WIDTH = 1024
TUNNEL_HEIGHT = 768
TUNNEL_DPI = 96
TUNNEL_TIMEZONE = "UTC"
TUNNEL_AUDIO = ("audio/L8", "audio/L16")
TUNNEL_IMAGE = ("image/png", "image/jpeg", "image/webp")

# How long a tunnel check listens before answering, and deliberately generous: reading
# stops early at the first sign either way (see PAINTED_OPCODES), so this only bounds a
# console that says *nothing*, and a Windows RDP login on a small host can take tens of
# seconds to paint its first frame. A window that closed before that would call a healthy
# desktop broken.
TUNNEL_SECONDS = 30.0

# The opcodes that mean a console has put something on the screen. Everything before them
# is handshaking, and for RDP the handshake is long: measured against a real Windows guest,
# guacd sends `cursor`, `mouse` and `sync` first, and sends its own `error` *after* them
# when the guest or the login is bad. So a check that answers at the first instruction
# cannot tell a desktop from a refused password — it waits for one of these, or for an
# error, and a Linux terminal reaches `img` within about a frame.
PAINTED_OPCODES = frozenset(
    {"arc", "blob", "cfill", "copy", "distort", "img", "png", "rect", "transfer", "webp"}
)

# The one instruction a check ever sends, and how often. Measured against a real Windows
# guest: guacd sends `nop` after ten seconds of hearing nothing from the client, again at
# fifteen, and then aborts the connection with status 776, "Aborted. See logs." A browser is
# never silent that long — `Guacamole.Client` sends a bare `nop` every five seconds
# (`KEEP_ALIVE_FREQUENCY`) — so a check that listened in silence would let a slow first
# frame be ended by its own silence and then blame the console for it. `nop` is a no-op
# (guacd answers it, the remote program never sees it), and this is the only thing sent.
LIVENESS_REPLY = "3.nop;"
KEEPALIVE_SECONDS = 5.0

# How long the WebSocket upgrade itself may take, which is a different question and needs a
# looser answer. Measured on a real range while the sweep cloned and destroyed a machine
# beside it: 1 upgrade in 28 took longer than 8 seconds and was reported as a console that
# does not open, and every retry of it was instant. A browser waits far longer than that,
# so a check that gives up sooner is the one that is wrong.
TUNNEL_OPEN_SECONDS = 30.0


def tunnel_url(
    base: str,
    *,
    token: str,
    connection_id: str,
    width: int = TUNNEL_WIDTH,
    height: int = TUNNEL_HEIGHT,
    dpi: int = TUNNEL_DPI,
    timezone: str = TUNNEL_TIMEZONE,
) -> str:
    """The ``wss://`` URL the webapp's WebSocket tunnel is opened on.

    Built here rather than in the portal because it is the one piece of the console a
    browser *must* agree with: a check that assembles its own URL can pass while the page
    hands over something else. The scheme follows the console's own — a range served over
    plain HTTP has no certificate to upgrade to, and `ws://` is what the webapp's own
    client would derive from it.
    """
    parsed = urlparse(base)
    scheme = {"http": "ws", "https": "wss"}.get(parsed.scheme.lower())
    if not scheme or not parsed.netloc:
        raise GuacError(
            f"the console base URL must be http:// or https:// for a tunnel to open on, got {base!r}"
        )
    # The path is kept as given (the webapp is base-relative and the portal passes it
    # through unchanged) with only the trailing slash it needs to be joined to.
    path = parsed.path if parsed.path.endswith("/") else f"{parsed.path}/"
    query = [
        ("token", token),
        ("GUAC_DATA_SOURCE", TUNNEL_DATA_SOURCE),
        ("GUAC_ID", connection_id),
        ("GUAC_TYPE", TUNNEL_CONNECTION_TYPE),
        ("GUAC_WIDTH", str(width)),
        ("GUAC_HEIGHT", str(height)),
        ("GUAC_DPI", str(dpi)),
        ("GUAC_TIMEZONE", timezone),
        *(("GUAC_AUDIO", mimetype) for mimetype in TUNNEL_AUDIO),
        *(("GUAC_IMAGE", mimetype) for mimetype in TUNNEL_IMAGE),
    ]
    # `quote`, not `quote_plus`: the webapp builds this string with encodeURIComponent,
    # which leaves spaces as %20 — and the token is the one parameter that must survive
    # the trip byte for byte (a gateway that reads it as `+` rejects the tunnel).
    encoded = urllib.parse.urlencode(query, quote_via=quote, safe="")
    return f"{scheme}://{parsed.netloc}{path}{TUNNEL_PATH}?{encoded}"


class InstructionParser:
    """A streaming parser for the Guacamole protocol's instruction format.

    ``LENGTH.VALUE,LENGTH.VALUE,...;`` — the length prefixes are what make the format
    streamable, which is also why it cannot be line- or JSON-based here: frames arrive
    mid-instruction, and one frame can carry several instructions. The unfinished tail is
    kept between calls.
    """

    def __init__(self) -> None:
        self._buffer = ""

    def feed(self, data: str) -> list[list[str]]:
        """Add a chunk and return the instructions it completed."""
        self._buffer += data
        instructions: list[list[str]] = []
        position = 0
        while True:
            index, elements, complete = position, [], False
            while True:
                dot = self._buffer.find(".", index)
                if dot < 0 or not self._buffer[index:dot].isdigit():
                    break
                length = int(self._buffer[index:dot])
                start = dot + 1
                end = start + length
                if end > len(self._buffer):
                    break
                elements.append(self._buffer[start:end])
                index = end
                if index >= len(self._buffer):
                    break
                separator = self._buffer[index]
                if separator == ",":
                    index += 1
                    continue
                if separator == ";":
                    complete = True
                    break
                # Anything else means this is not an instruction boundary: keep the
                # whole thing and let the next chunk make sense of it.
                break
            if not complete:
                break
            instructions.append(elements)
            position = index + 1
        self._buffer = self._buffer[position:]
        return instructions


@dataclass
class TunnelReport:
    """What one trip through the console tunnel saw.

    A record, deliberately, and not a verdict: the doctor probe, the per-session check
    and the tests all read the same events, and the sentence each of them says about
    them is that caller's own.
    """

    subprotocol: str = ""
    uuid: str = ""
    instructions: int = 0
    opcodes: dict[str, int] = field(default_factory=dict)
    errors: list[list[str]] = field(default_factory=list)
    closed: str = ""

    @property
    def opened(self) -> bool:
        """The webapp accepted the token and started a tunnel for this connection."""
        return bool(self.uuid)

    @property
    def error_text(self) -> str:
        """The message of the first error the far end sent, or ""."""
        return self.errors[0][0] if self.errors and self.errors[0] else ""

    @property
    def opcode_summary(self) -> str:
        """The opcodes seen, commonest first — what the console *did*, in one line."""
        ordered = sorted(self.opcodes.items(), key=lambda item: (-item[1], item[0]))
        return ", ".join(name for name, _count in ordered[:8])


def _record(report: TunnelReport, instruction: list[str]) -> None:
    """Fold one parsed instruction into the report. The tunnel's UUID is not an opcode."""
    opcode = instruction[0] if instruction else ""
    arguments = instruction[1:]
    if not opcode:
        # `Guacamole.Tunnel.INTERNAL_DATA_OPCODE`: the empty opcode, which the webapp's
        # tunnel uses for its own bookkeeping. The first one carries the tunnel's UUID.
        if arguments and not report.uuid:
            report.uuid = arguments[0]
        return
    report.instructions += 1
    report.opcodes[opcode] = report.opcodes.get(opcode, 0) + 1
    if opcode == "error":
        report.errors.append(arguments)


def _websocket_client():
    """The WebSocket client, imported where it is used and named when it is missing.

    Every other check in this module is stdlib-only, and `ontrak doctor` exists to run on
    a host whose dependencies are half-installed — the reason it checks for its own
    modules in the first place. So the one check that needs more says which package is
    absent rather than taking the import of the whole module down with it, and the probes
    ask for it *before* they start: a check that cannot be run is a different answer from
    a console that does not open.
    """
    try:
        from websockets.sync.client import connect  # noqa: PLC0415
    except ImportError as exc:
        raise GuacError(
            "the `websockets` package is not installed, so the console tunnel cannot be "
            "opened: pip install -r requirements.txt"
        ) from exc
    return connect


def _open_tunnel(url: str, timeout: float):
    """Open one tunnel with the WebSocket client above."""
    connect = _websocket_client()
    return connect(
        url,
        subprotocols=[TUNNEL_SUBPROTOCOL],
        # The same deliberate leniency as the HTTP probes: `make up` serves the console
        # over a local self-signed certificate, and a check that verified it would fail
        # on the shipped default.
        ssl=_probe_tls_context() if url.lower().startswith("wss:") else None,
        open_timeout=timeout,
        close_timeout=2,
        max_size=None,
        # Never through a proxy the host happens to have configured: the console address
        # is the operator's own, and the client library would otherwise honour
        # HTTP_PROXY, which no part of this stack is designed around.
        proxy=None,
    )


def _tunnel_failure(exc: Exception, url: str) -> str:
    """One sentence for any way the WebSocket handshake can fail."""
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    where = url.split("?")[0]
    if status:
        return (
            f"the console gateway refused the tunnel at {where} with HTTP {status} — the "
            "token is not valid for this connection, or the WebSocket upgrade never "
            "reached the webapp"
        )
    return f"could not open the console tunnel at {where}: {exc}"


def drive_tunnel(
    url: str,
    *,
    seconds: float = TUNNEL_SECONDS,
    open_seconds: float = TUNNEL_OPEN_SECONDS,
    connect=None,
) -> TunnelReport:
    """Open the console's WebSocket tunnel and listen, the way a browser does.

    Nothing is sent that means anything: the tunnel speaks first, and the only thing a check
    ever sends is the keep-alive a browser also sends (see :data:`LIVENESS_REPLY`) — a check
    must not type into a student's shell. Reading stops at the first instruction that means
    something arrived — a paint, or an error (see :data:`PAINTED_OPCODES`) — so a healthy
    console costs about a frame and a dead one costs the whole window.

    ``seconds`` is how long to listen once it is open, ``open_seconds`` how long the
    upgrade itself may take (see :data:`TUNNEL_OPEN_SECONDS` for why they differ), and
    ``connect`` the seam the tests use — a callable ``(url, timeout)`` returning a context
    manager whose ``recv(timeout=...)`` yields frames and raises ``TimeoutError`` when none
    arrive in time — defaulting to the `websockets` client.
    """
    report = TunnelReport()
    opener = connect or _open_tunnel
    deadline = time.monotonic() + seconds
    try:
        with opener(url, open_seconds) as socket:
            # Not merely recorded for its own sake: a browser refuses a WebSocket whose
            # subprotocol the server did not accept, so this decides whether the tunnel
            # is usable at all. Judged by the caller, not here.
            report.subprotocol = str(getattr(socket, "subprotocol", None) or "")
            parser = InstructionParser()
            last_keepalive = time.monotonic()
            while True:
                now = time.monotonic()
                if now >= deadline:
                    break
                # The browser's own keep-alive, at the browser's own cadence. Bounding the
                # read by it is also what makes the loop wake often enough to send it.
                if now - last_keepalive >= KEEPALIVE_SECONDS:
                    socket.send(LIVENESS_REPLY)
                    last_keepalive = time.monotonic()
                try:
                    frame = socket.recv(timeout=max(0.01, min(deadline - now, KEEPALIVE_SECONDS)))
                except TimeoutError:
                    # Nothing yet. The deadline is what ends a wait, not one quiet read —
                    # a console that is about to paint may say nothing for a while first.
                    continue
                if isinstance(frame, bytes):
                    frame = frame.decode("utf-8", "replace")
                for instruction in parser.feed(frame):
                    _record(report, instruction)
                if report.errors or PAINTED_OPCODES.intersection(report.opcodes):
                    break
    except Exception as exc:  # noqa: BLE001 - see below
        # Every way this can fail is one finding — refused, 403, wrong subprotocol, DNS,
        # TLS — and it belongs in the report rather than in a traceback out of `doctor`.
        report.closed = _tunnel_failure(exc, url)
    return report


def tunnel_verdict(report: TunnelReport, *, base: str, placeholder: bool = False) -> tuple[str, str]:
    """The state and the sentence for one tunnel report. ``(state, detail)``.

    ``placeholder`` says the connection named nothing real, which is what makes guacd's
    own error about it the *expected* answer rather than a finding.
    """
    where = f"the console tunnel at {base}"
    if not report.opened:
        if report.closed:
            return "unreachable", f"{report.closed}, so no tunnel UUID ever arrived"
        return "unreachable", (
            f"{where} opened but nothing at all came back: the webapp sends the tunnel's "
            "UUID only once it has a guacd to talk to, so this is guacd (down, or "
            "unreachable from the webapp) or the webapp itself"
        )
    negotiated = f"{where} opened with the {TUNNEL_SUBPROTOCOL!r} subprotocol"
    if report.subprotocol != TUNNEL_SUBPROTOCOL:
        return "degraded", (
            f"{where} opened, but the gateway did not negotiate the "
            f"{TUNNEL_SUBPROTOCOL!r} subprotocol (got {report.subprotocol or 'none'!r}); a "
            "browser refuses a WebSocket whose subprotocol was not accepted and falls "
            "back to the HTTP tunnel, which is slower but keeps working"
        )
    if report.errors:
        message = report.error_text or "(no message)"
        if placeholder:
            return "ok", (
                f"{negotiated} and guacd answered for the placeholder connection: "
                f"{message!r} — the expected answer, since this check names no real guest"
            )
        return "error", f"{negotiated}, but guacd reported {message!r}"
    if not PAINTED_OPCODES.intersection(report.opcodes):
        # guacd answered, but never drew anything and never complained: a console that
        # opens onto a blank frame is the failure this exists to name, and "it replied"
        # would be the wrong answer for it.
        return "empty", (
            f"{negotiated} and guacd answered, but nothing was painted within the check's "
            f"window ({report.instructions} instruction(s): {report.opcode_summary or 'none'})"
        )
    described = f"{report.instructions} instructions ({report.opcode_summary})"
    if placeholder:
        return "ok", (
            f"{negotiated} and guacd sent {described} for the placeholder connection"
        )
    return "ok", f"{negotiated} and guacd painted {described}, with no error"


def probe_tunnel(
    settings,
    *,
    timeout: float = PROBE_TIMEOUT_SECONDS,
    seconds: float = TUNNEL_SECONDS,
    open_seconds: float = TUNNEL_OPEN_SECONDS,
    post=None,
    get=None,
    connect=None,
):
    """Open the console's WebSocket tunnel, the way a browser does. ``(state, detail)``.

    The last of the three requests a console makes, and the one that decides whether a
    student actually sees a machine. It signs the same placeholder connection as the other
    probes — a name, not a guest — so what it proves is the path: the gateway forwarded
    the WebSocket upgrade, the webapp negotiated the ``guacamole`` subprotocol, and the
    webapp had a guacd to talk to.

    That last point is why this is worth asking separately. Measured on a real range with
    guacd stopped: the WebSocket still upgrades, the subprotocol is still negotiated, and
    then **nothing arrives at all** — the webapp sends the tunnel's UUID only once it has
    a guacd connection. So an instruction after the UUID means the whole chain from the
    browser to guacd is up, and silence is a missing link no other check here can see:
    the gateway is healthy, the key agrees, the connection is listed, and the console
    still opens onto nothing.

    States: ``ok``, ``degraded`` (the tunnel works, but browsers fall back to the slower
    HTTP tunnel), ``refused`` (the tunnel was rejected), ``unreachable`` (it opened and
    stayed silent, or would not open at all), ``skipped`` (no console configured, or no
    WebSocket client installed).
    """
    base, skip = _probe_base(settings)
    if skip is not None:
        return skip
    if connect is None:
        try:
            _websocket_client()
        except GuacError as exc:
            return "skipped", str(exc)
    kind, detail, token, identifier = _open_connection(
        settings, base, _probe_payload(settings), timeout, post, get
    )
    if kind != "accepted":
        return kind, detail
    try:
        url = tunnel_url(base, token=token, connection_id=identifier)
    except GuacError as exc:
        return "skipped", str(exc)
    report = drive_tunnel(url, seconds=seconds, open_seconds=open_seconds, connect=connect)
    return tunnel_verdict(report, base=base, placeholder=True)


def verify_session_console(
    settings,
    session: Session,
    scenario: Scenario | None = None,
    *,
    timeout: float = PROBE_TIMEOUT_SECONDS,
    seconds: float = TUNNEL_SECONDS,
    open_seconds: float = TUNNEL_OPEN_SECONDS,
    post=None,
    get=None,
    connect=None,
) -> tuple[str, str, TunnelReport]:
    """Open *one student's* console over the real stack. ``(state, detail, report)``.

    What `ontrak console verify` and its scenario sweep run: the same three requests a
    browser makes, for a session that exists, against the guest that session was given —
    so the connection this portal signed for *this* machine is the one that has to paint.

    States: ``ok``, ``error`` (the tunnel opened and guacd reported a failure — a refused
    login, an sshd that is not running, a guest that is gone), ``empty`` (opened, and guacd
    said nothing at all), ``refused``, ``degraded``, ``skipped`` — the last four as in
    :func:`tunnel_verdict`.
    """
    report = TunnelReport()
    base, skip = _probe_base(settings)
    if skip is not None:
        return skip[0], skip[1], report
    if connect is None:
        try:
            _websocket_client()
        except GuacError as exc:
            return "skipped", str(exc), report
    if not session.host_ip:
        return (
            "refused",
            f"session {session.id} has no machine address yet, so there is no console to open",
            report,
        )
    if protocol_for(settings, scenario) == "":
        return (
            "skipped",
            f"scenario {session.scenario_id} gets no browser console on this range "
            "(guac.linux_ssh is off), so there is nothing to open",
            report,
        )
    name = connection_name(session, scenario)
    kind, detail, token, identifier = _open_connection(
        settings, base, build_payload(settings, session, scenario), timeout, post, get, name=name
    )
    if kind != "accepted":
        return kind, detail, report
    try:
        url = tunnel_url(base, token=token, connection_id=identifier)
    except GuacError as exc:
        return "refused", str(exc), report
    report = drive_tunnel(url, seconds=seconds, open_seconds=open_seconds, connect=connect)
    state, detail = tunnel_verdict(report, base=base)
    return state, detail, report


def same_origin(first: str, second: str) -> bool:
    """Whether two absolute URLs share scheme, host and port.

    This is the scope of a browser's ``localStorage``, and therefore the question
    that decides whether the portal's page is allowed to clear Guacamole's cached
    auth token before embedding a console: same origin, and it can; different
    origin, and the token is out of reach. See the console bootstrap page.
    """
    try:
        a, b = urlparse(first), urlparse(second)
    except ValueError:
        return False
    if not a.scheme or not b.scheme or not a.netloc or not b.netloc:
        return False

    def parts(parsed):
        default_port = {"http": 80, "https": 443}.get(parsed.scheme.lower())
        try:
            port = parsed.port
        except ValueError:
            port = None
        return parsed.scheme.lower(), (parsed.hostname or "").lower(), port or default_port

    return parts(a) == parts(b)


def request_origin(request) -> str:
    """The scheme and host a *browser* used to reach the portal, as one string.

    Behind the stack's origin gateway the values a student's browser actually used
    arrive in ``X-Forwarded-Proto``/``X-Forwarded-Host`` (the gateway sets both from
    ``$scheme``/``$host``); a direct connection has neither, so the request's own URL
    is the fallback. Either header may carry a comma-separated chain, and only the
    first value — the client's — is the address to hand back.
    """
    headers = request.headers
    proto = headers.get("x-forwarded-proto") or request.url.scheme or "http"
    host = headers.get("x-forwarded-host") or headers.get("host") or request.url.netloc or ""
    proto = proto.split(",")[0].strip().lower() or "http"
    host = host.split(",")[0].strip().rstrip("/")
    return f"{proto}://{host}"


def resolve_base_url(settings, request=None) -> str:
    """The absolute console URL to embed, resolving ``auto`` if that is the setting.

    Three configurations, in the order an operator meets them:

    * an absolute URL (``https://range.example/guacamole/``) — used as given. What a
      deployment behind Cerulean's TLS edge sets, because the browser name is not
      the one the container answers on.
    * ``auto`` — derived from the request serving the page, so the console follows
      whatever address the student reached the portal on. This is the default, and
      it is what makes a lab on a laptop, a phone or a LAN work with no editing.
    * empty — no console at all; the portal explains instead of embedding a frame
      that cannot open.
    """
    base = (settings.guac.base_url or "").strip()
    if not base:
        raise GuacError("guac.base_url is not configured")
    if base.lower() != AUTO_BASE_URL:
        return base if base.endswith("/") else f"{base}/"
    if request is None:
        raise GuacError(
            "guac.base_url is 'auto', and no request is available to derive the "
            "console address from: set an absolute URL for a caller with no browser "
            "request (a CLI, a probe)"
        )
    return f"{request_origin(request)}{CONSOLE_PATH}"


def origin_of(url: str) -> str:
    """Just the scheme and authority of an absolute URL — no path, no query."""
    try:
        parts = urlparse(str(url or ""))
    except ValueError:
        return ""
    if not parts.scheme or not parts.netloc:
        return ""
    return f"{parts.scheme.lower()}://{parts.netloc.lower()}"


def console_origin_warning(settings, request) -> str:
    """What to tell a student when the console is not on the portal's own origin.

    The console bootstrap clears Guacamole's stored auth token before opening the URL
    the portal signed, which is what stops a browser opening the *previous* machine.
    ``localStorage`` is scoped to an origin, so that clear only works when the console
    is served from the same origin as the portal page — true by construction when
    ``guac.base_url`` is ``auto`` (the default), and false whenever an operator pins it
    to an absolute URL on some other name.

    The portal cannot reach across origins to fix it, so the honest thing is to say so
    on the page that is about to open the console, instead of leaving a student to
    wonder why the machine they were pointed at is not the one on screen. Returns ""
    when there is nothing to warn about, which is the normal case.
    """
    base = (settings.guac.base_url or "").strip()
    if not base or base.lower() == AUTO_BASE_URL:
        return ""
    try:
        resolved = resolve_base_url(settings, request)
    except GuacError:
        return ""
    origin = request_origin(request)
    if same_origin(resolved, origin):
        return ""
    return (
        f"This range serves its console from {origin_of(resolved)}, a different site "
        f"from the portal at {origin}. Browsers keep each site's stored sign-in "
        "separately, so this page cannot clear the console's cached session: if this "
        "browser has opened another machine on that console, it may keep opening that "
        "one until the cached session expires. The fix is to serve the console and the "
        "portal from one name (guac.base_url: auto does that), or to clear this "
        "browser's site data for the console."
    )


def pinned_base_url_note(settings) -> str:
    """An operator note for a console pinned to an absolute URL, or "".

    ``auto`` makes the console follow the address the student's browser used, which is
    what lets one checkout serve a laptop, a LAN address and a TLS name with no
    editing. A pinned URL gives that up, and the cost is not obvious at deploy time: a
    browser that has opened another range on that gateway can open the previous
    session's machine (see :func:`console_origin_warning`). `ontrak doctor` says so.
    """
    base = (settings.guac.base_url or "").strip()
    if not base or base.lower() == AUTO_BASE_URL:
        return ""
    return (
        f"guac.base_url is pinned to {base} instead of 'auto', so the console does not "
        "follow the address a student's browser used. That is correct behind a TLS edge "
        "whose name differs from what this host answers on, and a problem on a LAN "
        "range reached by IP: a browser that has used another range on that gateway can "
        "open the previous session's machine, because its stored auth token wins and "
        "only a same-origin page can clear it."
    )


def build_link(
    settings,
    session: Session,
    scenario: Scenario | None = None,
    now: float | None = None,
    request=None,
) -> str:
    """Return the URL to embed in the portal's console iframe.

    ``request`` is what makes ``guac.base_url: auto`` work: the portal passes the
    request that is rendering the student's page, and the console follows the
    address they used. It is optional so the CLI and tests can call this with a
    fixed base URL. Passing ``guac.base_url`` empty still raises ``GuacError``.
    """
    base = resolve_base_url(settings, request)
    payload = build_payload(settings, session, scenario, now=now)
    data = encode_payload(payload, settings.guac.secret_bytes())
    # The URL form Guacamole documents for an embedded connection. Do not add a
    # cache-buster to it: busting the *document* does not help (see
    # :func:`same_origin`), because the browser's stored auth token, not a cached
    # document, is what decides which connection opens.
    return f"{base}#/?data={quote(data, safe='')}"
