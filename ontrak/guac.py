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
    title = scenario.title if scenario else session.scenario_id
    return {
        "username": session.student,
        "expires": expires_ms,
        "connections": {
            f"OnTrak #{session.id} - {title}": {
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

    Same states as :func:`probe_gateway`: ``ok``, ``refused``, ``unreachable``,
    ``skipped``.
    """
    base, skip = _probe_base(settings)
    if skip is not None:
        return skip
    kind, detail, token = _request_token(settings, base, _probe_payload(settings), timeout, post)
    if kind != "accepted":
        return kind, detail
    if not token:
        return "unreachable", (
            f"the console gateway at {base} accepted a payload signed with guac.secret_key "
            "but returned no authToken, so there is no session for a browser to open"
        )
    url = f"{base}api/session/data/json/connections?token={quote(token, safe='')}"
    reader = get or _get
    try:
        status, body = reader(url, timeout)
    except (OSError, ValueError) as exc:
        return "unreachable", f"could not read the console's connection list from {base}: {exc}"
    if status != 200:
        return "unreachable", (
            f"the console gateway at {base} accepted the payload but answered HTTP "
            f"{status} for its connection list: {body[:200]}"
        )
    # Matched on the connection's *name*: that is the key Guacamole lists a connection
    # under (and what a student sees in the console's menu), so it is the string the
    # browser's next request would have to find. The payload's `id` is what the
    # connection is addressed by internally.
    if PROBE_CONNECTION_NAME not in body:
        return "refused", (
            f"the console gateway at {base} issued a token but its connection list does "
            f"not contain {PROBE_CONNECTION_NAME!r}, so a student's freshly signed link "
            "opens nothing. Its JSON auth extension is not registering the payload — "
            "check that JSON_ENABLED is true on the gateway (docker-compose.yml)."
        )
    return "ok", (
        f"the console gateway registered {PROBE_CONNECTION_NAME!r} for a freshly signed "
        f"payload and listed it back at {base} — a student's console link opens the "
        "connection this portal signed"
    )


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
