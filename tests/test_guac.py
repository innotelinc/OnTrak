from __future__ import annotations

import base64
import hashlib
import hmac
import json
import shutil
import subprocess
import sys
import time
from urllib.parse import parse_qs, quote, urlparse

import pytest

from ontrak import guac

# `console verify`'s target selection: a pure function of the catalogue and the flags,
# which is why the sweep can be tested without opening a console at all.
from ontrak.cli import _console_targets
from ontrak.models import Session

from .conftest import GUAC_KEY

KEY = bytes.fromhex(GUAC_KEY)


def make_session(**overrides) -> Session:
    data = {
        "id": 42,
        "student": "alice",
        "scenario_id": "net-dns-failure",
        "host_ip": "10.20.0.150",
        "rdp_user": "student",
        "rdp_password": "TrainMe!12345",
    }
    data.update(overrides)
    return Session(**data)


def test_payload_round_trips():
    payload = {"username": "alice", "expires": 1234567890123, "connections": {"c": {"protocol": "rdp"}}}
    data = guac.encode_payload(payload, KEY)
    assert guac.decode_payload(data, KEY) == payload


def test_wrong_key_fails_the_signature():
    data = guac.encode_payload({"username": "alice"}, KEY)
    with pytest.raises(guac.GuacError):
        guac.decode_payload(data, bytes.fromhex("ff" * 16))


def test_tampering_is_detected():
    data = guac.encode_payload({"username": "alice"}, KEY)
    raw = bytearray(base64.b64decode(data))
    raw[40] ^= 0x01  # flip a bit in the ciphertext
    with pytest.raises(guac.GuacError):
        guac.decode_payload(base64.b64encode(bytes(raw)).decode(), KEY)


def test_key_length_is_validated():
    with pytest.raises(guac.GuacError, match="16 bytes"):
        guac.encode_payload({"username": "alice"}, b"tooshort")


@pytest.mark.skipif(shutil.which("openssl") is None, reason="openssl not available")
def test_matches_openssl_reference_implementation():
    """Cross-check against OpenSSL: HMAC-SHA256, prepend, AES-128-CBC, zero IV, PKCS#7.

    This is the format guacamole-auth-json verifies, computed here by an
    independent implementation (the openssl CLI) rather than by our own code.
    """
    payload = {
        "username": "test",
        "expires": 1446323765000,
        "connections": {"My Connection": {"protocol": "rdp", "parameters": {"hostname": "10.10.209.63"}}},
    }
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")

    signature = subprocess.run(
        ["openssl", "dgst", "-sha256", "-mac", "HMAC", "-macopt", f"hexkey:{KEY.hex()}", "-binary"],
        input=raw,
        capture_output=True,
        check=True,
    ).stdout
    assert len(signature) == 32

    encrypted = subprocess.run(
        [
            "openssl", "enc", "-aes-128-cbc",
            "-K", KEY.hex(),
            "-iv", "00" * 16,
            "-nosalt",
            "-base64",
        ],
        input=signature + raw,
        capture_output=True,
        check=True,
    ).stdout
    expected = b"".join(encrypted.split()).decode("ascii")

    assert guac.encode_payload(payload, KEY) == expected


def test_wire_format_is_signature_then_json_before_encryption():
    """Pin the layout the Guacamole manual specifies: signature || json, AES-CBC, zero IV."""
    from cryptography.hazmat.primitives import padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    payload = {"username": "test"}
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    ciphertext = base64.b64decode(guac.encode_payload(payload, KEY))

    decryptor = Cipher(algorithms.AES(KEY), modes.CBC(b"\x00" * 16)).decryptor()
    padded = decryptor.update(ciphertext) + decryptor.finalize()
    unpadder = padding.PKCS7(128).unpadder()
    blob = unpadder.update(padded) + unpadder.finalize()

    assert blob[:32] == hmac.new(KEY, raw, hashlib.sha256).digest()
    assert blob[32:] == raw


def test_rdp_parameters_use_the_session_credentials(settings):
    session = make_session()
    params = guac.rdp_parameters(settings, session)
    assert params["hostname"] == "10.20.0.150"
    assert params["username"] == "student"
    assert params["password"] == "TrainMe!12345"
    assert params["ignore-cert"] == "true"
    assert params["port"] == str(settings.guest.rdp_port)


def test_recording_is_opt_in(settings):
    session = make_session()
    settings.guac.recording = False
    assert "recording-path" not in guac.rdp_parameters(settings, session)
    settings.guac.recording = True
    params = guac.rdp_parameters(settings, session)
    assert params["recording-path"] == settings.guac.recording_path
    assert str(session.id) in params["recording-name"]


def test_link_is_a_browser_url_with_an_encrypted_payload(settings, repo):
    session = make_session()
    scenario = repo.get("net-dns-failure")
    now = time.time()
    link = guac.build_link(settings, session, scenario, now=now)

    parsed = urlparse(link)
    assert parsed.scheme == "http" and parsed.netloc == "guac.test"
    assert parsed.path == "/guacamole/"
    # No cache-buster on the document. One was added here to stop a browser reusing
    # the previous session's Guacamole page, and it did not work: what decides which
    # connection opens is the auth token the browser has *stored*, not a cached
    # document. The console bootstrap page clears that token instead.
    assert parsed.query == ""
    assert parsed.fragment.startswith("/?data=")
    data = parse_qs(parsed.fragment.lstrip("/?"))["data"][0]

    payload = guac.decode_payload(data, KEY)
    assert payload["username"] == "alice"
    expected_expiry = int((now + settings.guac.link_ttl_minutes * 60) * 1000)
    assert abs(payload["expires"] - expected_expiry) <= 1000
    connections = payload["connections"]
    assert len(connections) == 1
    (name, connection), = connections.items()
    assert scenario.title in name
    assert connection["parameters"]["hostname"] == "10.20.0.150"
    # The payload is encrypted, so the RDP password is not readable in the URL.
    assert "TrainMe" not in link


def test_link_requires_an_address(settings):
    with pytest.raises(guac.GuacError, match="no host address"):
        guac.build_link(settings, make_session(host_ip=""), None)


def test_link_requires_a_configured_gateway(settings):
    settings.guac.base_url = ""
    with pytest.raises(guac.GuacError, match="base_url"):
        guac.build_link(settings, make_session(), None)


class _Request:
    """The two things the address resolution reads off a Starlette Request."""

    def __init__(self, headers: dict, scheme: str = "http", netloc: str = "localhost:8080") -> None:
        self.headers = headers
        self.url = type("U", (), {"scheme": scheme, "netloc": netloc})()


def test_auto_console_follows_the_address_the_student_used(settings):
    """`guac.base_url: auto` (the default) keeps the console on the student's address.

    The failure it prevents: a checkout that works at `http://127.0.0.1:8080` hands a
    student who reached it at `http://192.168.1.9:8080` an iframe pointed at *their*
    localhost, which is their own laptop — a blank frame with nothing to explain it.
    One setting, three addresses, which is the whole point of a setup-anywhere lab.
    """
    settings.guac.base_url = "auto"
    request = _Request({"host": "192.168.1.9:8080"})
    link = guac.build_link(settings, make_session(), None, request=request)
    parsed = urlparse(link)
    assert parsed.netloc == "192.168.1.9:8080"
    assert parsed.path == "/guacamole/"


def test_auto_console_prefers_the_forwarded_origin(settings):
    """Behind the origin gateway the browser's scheme/host arrive as X-Forwarded-*.

    The gateway is nginx on plain HTTP while the student's browser is on TLS, so the
    request's own scheme is the wrong one to hand back — the forwarded values are the
    student's, and only the first entry of a chained header is theirs.
    """
    settings.guac.base_url = "auto"
    request = _Request(
        {
            "host": "portal:8080",
            "x-forwarded-proto": "https, http",
            "x-forwarded-host": "range.example, portal",
        }
    )
    link = guac.build_link(settings, make_session(), None, request=request)
    assert link.startswith("https://range.example/guacamole/#/?data=")


def test_auto_console_needs_a_request_to_be_derived_from(settings):
    """With no request (the CLI, a probe) there is no address to work out — say so."""
    settings.guac.base_url = "auto"
    with pytest.raises(guac.GuacError, match="no request is available"):
        guac.build_link(settings, make_session(), None)


# --------------------------------------------------------------------------- #
# same_origin
#
# The browser scope of localStorage, and so the question that decides whether the
# portal's own page may clear Guacamole's cached auth token. `guac.base_url: auto`
# (the default) puts the console on the portal's origin, which is the case this
# answers "yes" for.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "first,second,expected",
    [
        ("http://host:8080/guacamole/", "http://host:8080/sessions/4", True),
        ("http://host/guacamole/", "http://host/sessions/4", True),
        ("https://host/guacamole/", "https://host:443/x", True),
        # Scheme, host and port are all part of it: each of these is a different
        # storage silo in the browser.
        ("https://host/guacamole/", "http://host/guacamole/", False),
        ("http://host:8443/guacamole/", "http://host:8080/guacamole/", False),
        ("http://guac.test/guacamole/", "http://testserver/sessions/4", False),
        # Not absolute URLs: nothing to compare, and the safe reading is "cannot
        # reach that storage", so no clearing is attempted.
        ("/guacamole/", "http://host/", False),
        ("http://host/", "", False),
    ],
)
def test_same_origin_is_the_browsers_storage_scope(first, second, expected):
    assert guac.same_origin(first, second) is expected


def test_the_gateway_probe_skips_an_auto_console(settings):
    """`auto` is a browser address: there is no fixed URL here to POST a token to."""
    settings.guac.base_url = "auto"
    state, detail = guac.probe_gateway(settings, post=lambda *a: (_ for _ in ()).throw(AssertionError()))
    assert state == "skipped"
    assert "auto" in detail


@pytest.mark.skipif(
    not __import__("os").environ.get("ONTRAK_GUAC_INTEROP_URL"),
    reason="set ONTRAK_GUAC_INTEROP_URL to POST the payload to a live Guacamole",
)
def test_live_guacamole_accepts_the_payload(settings):  # pragma: no cover - needs a gateway
    import urllib.parse
    import urllib.request

    url = __import__("os").environ["ONTRAK_GUAC_INTEROP_URL"]
    data = guac.encode_payload(guac.build_payload(settings, make_session()), KEY)
    body = urllib.parse.urlencode({"data": data}).encode()
    with urllib.request.urlopen(url.rstrip("/") + "/api/tokens", data=body, timeout=10) as response:
        assert response.status == 200


class _Scenario:
    """The fields the protocol decision reads."""

    def __init__(self, platform: str, scenario_id: str = "s") -> None:
        self.platform = platform
        self.id = scenario_id
        self.title = f"{platform} scenario"

    @property
    def is_linux(self) -> bool:
        return self.platform == "linux"


def test_a_windows_guest_gets_rdp(settings):
    scenario = _Scenario("windows")
    assert guac.protocol_for(settings, scenario) == "rdp"
    payload = guac.build_payload(settings, make_session(), scenario)
    connection = next(iter(payload["connections"].values()))
    assert connection["protocol"] == "rdp"
    assert connection["parameters"]["port"] == str(settings.guest.rdp_port)


def test_a_linux_container_gets_no_console_when_the_transport_is_off(settings):
    # The reported failure: the console iframe was an RDP session pointed at a
    # Linux container, which has no RDP server, so every container scenario showed
    # "the remote desktop server is currently unreachable". With `guac.linux_ssh`
    # off — the one posture where nothing has put an sshd in the image — the honest
    # answer is no console at all, and the portal says so instead of embedding one
    # that cannot connect. (It is on in the shipped config; this is the opt-out.)
    settings.guac.linux_ssh = False
    scenario = _Scenario("linux")
    assert guac.protocol_for(settings, scenario) == ""
    with pytest.raises(guac.GuacError, match="no remote desktop"):
        guac.build_payload(settings, make_session(), scenario)


def test_a_linux_guest_gets_ssh_when_the_image_runs_sshd(settings):
    settings.guac.linux_ssh = True
    scenario = _Scenario("linux")
    assert guac.protocol_for(settings, scenario) == "ssh"
    payload = guac.build_payload(settings, make_session(rdp_user="", rdp_password=""), scenario)
    connection = next(iter(payload["connections"].values()))
    assert connection["protocol"] == "ssh"
    assert connection["parameters"]["port"] == str(settings.guest.ssh_port)
    assert connection["parameters"]["username"] == settings.guest.linux_user
    # An SSH console has no desktop to resize; asking for one would be noise.
    assert "resize-method" not in connection["parameters"]


def test_a_linux_console_logs_in_as_the_account_the_template_provisioned(settings):
    """A real Linux session carries the Windows RDP user; the console must not use it.

    `create_session` sets ``rdp_user = guest.user`` (the training account on a Windows
    guest), and the old code preferred it here too — but the SSH console transport a
    Linux template is built with sets the password for ``guest.linux_user`` and nothing
    else. So every Linux console asked guacd to log in as an account the image did not
    have, and the shell refused: a console that never opened, on a scenario that was
    fine. The test above passes ``rdp_user=""``, which is why it never caught this.
    """
    settings.guac.linux_ssh = True
    settings.guest.user = "student"
    settings.guest.password = "TrainMe!12345"
    assert settings.guest.linux_user == "root"  # the shipped default
    scenario = _Scenario("linux")
    session = make_session(rdp_user="student", rdp_password="TrainMe!12345")
    payload = guac.build_payload(settings, session, scenario)
    connection = next(iter(payload["connections"].values()))
    assert connection["parameters"]["username"] == "root"
    assert connection["parameters"]["password"] == "TrainMe!12345"
    # ...and the RDP half still gets the training account.
    rdp = guac.rdp_parameters(settings, session)
    assert rdp["username"] == "student"


def test_the_gateway_probe_signs_with_the_portals_own_key(settings):
    """The probe must test the agreement, not merely reach the gateway.

    It sends a payload signed with `guac.secret_key` — the same thing a student's link
    carries — so a gateway that accepts it is a gateway that will open the console.
    """
    sent = {}

    def post(url, fields, timeout):
        sent.update(url=url, fields=fields, timeout=timeout)
        return 200, '{"authToken":"abc","dataSource":"json"}'

    state, detail = guac.probe_gateway(settings, post=post)
    assert state == "ok", detail
    assert sent["url"].endswith("/guacamole/api/tokens")
    payload = guac.decode_payload(sent["fields"]["data"], settings.guac.secret_bytes())
    assert payload["connections"]["OnTrak doctor"]["protocol"] == "rdp"


def test_the_gateway_probe_names_a_key_mismatch(settings):
    """A refused payload is the "console never opens" state, and it must be blocking.

    Guacamole answers every student with this exact response when JSON_SECRET_KEY and
    guac.secret_key disagree — or when the JSON extension is off — and the portal has
    no way to notice, because it never sees the gateway's answer.
    """
    state, detail = guac.probe_gateway(
        settings, post=lambda url, fields, timeout: (403, '{"message":"Permission denied."}')
    )
    assert state == "refused"
    assert "JSON_SECRET_KEY" in detail
    assert "console never opens" in detail


def test_the_gateway_probe_warns_rather_than_fails_when_nothing_answers(settings):
    """Split-horizon DNS is normal: the browser's URL need not resolve on the host."""

    def dead(url, fields, timeout):
        raise OSError("name or service not known")

    state, detail = guac.probe_gateway(settings, post=dead)
    assert state == "unreachable"
    assert "could not reach" in detail


def test_the_gateway_probe_skips_when_there_is_no_console(settings):
    settings.guac.base_url = ""
    state, detail = guac.probe_gateway(settings, post=lambda *a: (_ for _ in ()).throw(AssertionError()))
    assert state == "skipped"
    assert "guac.base_url" in detail


# --------------------------------------------------------------------------- #
# the end-to-end console probe
#
# `probe_gateway` proves the key agrees. This proves the *connection* the browser
# reads back exists, which is what a student's console actually needs: a gateway
# can accept our payload as a token and still list no connection for it, and from
# the student's side that is an empty console on a healthy-looking stack.
# --------------------------------------------------------------------------- #
def test_the_probe_accepts_the_stacks_own_self_signed_certificate(monkeypatch):
    """`make up` serves the console over the local self-signed certificate.

    A probe that verified it would report "unreachable" on the shipped default, which
    is a false alarm on a healthy range — so it does not verify, and this pins that.
    """
    import ssl

    seen = {}

    class _Response:
        status = 200

        def read(self):
            return b'{"authToken":"tok"}'

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def fake_urlopen(request, timeout=None, context=None):
        seen["context"] = context
        return _Response()

    monkeypatch.setattr(guac.urllib.request, "urlopen", fake_urlopen)
    status, body = guac._post_form("https://range:8443/guacamole/api/tokens", {"data": "x"}, 5)
    assert (status, body) == (200, '{"authToken":"tok"}')
    assert seen["context"] is not None
    assert seen["context"].verify_mode is ssl.CERT_NONE
    assert seen["context"].check_hostname is False


def test_the_console_probe_follows_the_link_the_browser_would(settings):
    seen = {}

    def post(url, fields, timeout):
        seen["token_url"] = url
        return 200, '{"authToken":"tok-1","dataSource":"json"}'

    def get(url, timeout):
        seen["connections_url"] = url
        # The shape a real gateway answers with: connections keyed by *name*.
        return 200, '{"OnTrak doctor":{"name":"OnTrak doctor","protocol":"rdp"}}'

    state, detail = guac.probe_console(settings, post=post, get=get)
    assert state == "ok", detail
    # The token we were issued is the one the browser would carry next.
    assert seen["token_url"].endswith("/guacamole/api/tokens")
    assert "api/session/data/json/connections" in seen["connections_url"]
    assert "token=tok-1" in seen["connections_url"]


def test_the_console_probe_catches_a_token_with_no_connection(settings):
    """The silence this exists for: an accepted payload that registers nothing."""
    state, detail = guac.probe_console(
        settings,
        post=lambda url, fields, timeout: (200, '{"authToken":"tok-1"}'),
        get=lambda url, timeout: (200, '{}'),
    )
    assert state == "refused"
    assert "JSON_ENABLED" in detail
    assert guac.PROBE_CONNECTION_NAME in detail


def test_the_console_probe_reports_a_refused_key_like_the_gateway_probe(settings):
    state, detail = guac.probe_console(
        settings,
        post=lambda url, fields, timeout: (403, '{"message":"Permission denied."}'),
        get=lambda *a: (_ for _ in ()).throw(AssertionError("no token, so no listing")),
    )
    assert state == "refused"
    assert "JSON_SECRET_KEY" in detail


def test_the_console_probe_skips_an_auto_console(settings):
    settings.guac.base_url = "auto"
    state, detail = guac.probe_console(
        settings,
        post=lambda *a: (_ for _ in ()).throw(AssertionError()),
        get=lambda *a: (_ for _ in ()).throw(AssertionError()),
    )
    assert state == "skipped"
    assert "auto" in detail


# --------------------------------------------------------------------------- #
# the cross-origin guard
#
# The console bootstrap can only clear Guacamole's stored auth token when the
# console shares the portal's origin. A pinned `guac.base_url` on another site
# gives that up silently, so the portal says so on the page and `ontrak doctor`
# says so at deploy time.
# --------------------------------------------------------------------------- #
def test_a_pinned_console_on_another_origin_is_called_out(settings):
    settings.guac.base_url = "http://guac.test/guacamole/"
    request = _Request({"host": "192.168.1.9:8080"})
    warning = guac.console_origin_warning(settings, request)
    assert "different site" in warning
    assert "http://guac.test" in warning
    assert "192.168.1.9:8080" in warning


def test_an_auto_console_has_nothing_to_warn_about(settings):
    settings.guac.base_url = "auto"
    request = _Request({"host": "192.168.1.9:8080"})
    assert guac.console_origin_warning(settings, request) == ""
    assert guac.pinned_base_url_note(settings) == ""


def test_a_pinned_console_on_the_portals_own_origin_is_quiet(settings):
    """A range behind an edge reaches the portal on the console's name: no warning.

    This is the deployment the pinned setting exists for, so a guard that fired on it
    would be a permanent lie on a correctly configured range.
    """
    settings.guac.base_url = "https://range.example/guacamole/"
    request = _Request({"host": "portal:8080", "x-forwarded-host": "range.example", "x-forwarded-proto": "https"})
    assert guac.console_origin_warning(settings, request) == ""
    # ...but an operator still gets told what pinning costs.
    assert "pinned to" in guac.pinned_base_url_note(settings)


def test_an_unknown_scenario_still_gets_rdp(settings):
    # No scenario means the payload cannot be classified; RDP is the pre-existing
    # behaviour and the safer guess (a Windows VM is what the pool holds).
    assert guac.protocol_for(settings, None) == "rdp"


# --------------------------------------------------------------------------- #
# the console tunnel
#
# The third request a browser makes, and the only one that can tell a healthy
# gateway from a webapp with no guacd behind it: with guacd stopped, measured on a
# real range, the WebSocket still upgrades and the subprotocol is still negotiated
# and then *nothing arrives at all*, because the webapp sends the tunnel's UUID
# only once it has guacd to talk to. Every other check in this module passes on
# that stack, so this is the one that has to catch it. Driven offline: a fake
# connector feeds the frames a real tunnel sent.
# --------------------------------------------------------------------------- #
def wire(opcode: str, *arguments: str) -> str:
    """One instruction, spelled the way the Guacamole protocol spells it."""
    elements = [opcode, *arguments]
    return "".join(f"{len(element)}.{element}," for element in elements)[:-1] + ";"


# The UUID a real range's webapp assigned the tunnel these tests replay.
TUNNEL_UUID = "b1b29cb4-c8f3-4251-bc2e-c391129694f8"


class FakeTunnel:
    """A stand-in for the WebSocket ``drive_tunnel`` opens.

    It *is* the connector: calling it records the URL it was handed, and the instance it
    returns behaves like the `websockets` client does — ``subprotocol`` from the
    handshake, frames out of ``recv``, ``TimeoutError`` when the far end has gone quiet,
    and an exception out of ``__enter__`` for a refused upgrade.
    """

    def __init__(self, *frames, subprotocol="guacamole", handshake_fails=None):
        self.frames = list(frames)
        self.subprotocol = subprotocol
        self.handshake_fails = handshake_fails
        self.url = ""
        self.timeout = None
        self.sent: list[str] = []
        self.asked_after_draining = 0

    def __call__(self, url, timeout):
        self.url, self.timeout = url, timeout
        return self

    def __enter__(self):
        if self.handshake_fails:
            raise self.handshake_fails
        return self

    def __exit__(self, *exc):
        return False

    def send(self, data):
        self.sent.append(data)

    def recv(self, timeout=None):
        if not self.frames:
            # Reached only when a check wanted more than the far end had: the counter is
            # how a test tells a listener that stops early from one that drains its clock.
            self.asked_after_draining += 1
            raise TimeoutError("nothing more on the tunnel")
        return self.frames.pop(0)


def test_the_instruction_parser_streams_an_instruction_across_frames():
    parser = guac.InstructionParser()
    assert parser.feed("4.size,1.0") == []
    assert parser.feed(",4.1024,3.768;") == [["size", "0", "1024", "768"]]


def test_the_instruction_parser_returns_every_instruction_in_a_frame():
    parser = guac.InstructionParser()
    frame = wire("", TUNNEL_UUID) + wire("sync", "170895439", "0") + wire("nop")
    assert parser.feed(frame) == [["", TUNNEL_UUID], ["sync", "170895439", "0"], ["nop"]]


def test_the_tunnel_url_is_the_one_the_webapp_builds(settings):
    """The wire contract with a browser, taken from the deployed webapp.

    `Guacamole.WebSocketTunnel` for the path and the subprotocol and `ManagedClient` for
    these parameters — a check that assembles its own URL proves nothing about the URL a
    student's page hands over, and the parameters are what tell the webapp which
    connection to open, at what size, with which codecs.
    """
    url = guac.tunnel_url(settings.guac.base_url, token="tok-1", connection_id="OnTrak #42")
    parsed = urlparse(url)
    # The test range's console is plain http, so the browser's tunnel is plain ws.
    assert parsed.scheme == "ws"
    assert parsed.path == "/guacamole/websocket-tunnel"
    query = parse_qs(parsed.query)
    assert query["token"] == ["tok-1"]
    assert query["GUAC_DATA_SOURCE"] == ["json"]
    assert query["GUAC_ID"] == ["OnTrak #42"]
    assert query["GUAC_TYPE"] == ["c"]
    assert query["GUAC_WIDTH"] == ["1024"] and query["GUAC_HEIGHT"] == ["768"]
    assert query["GUAC_DPI"] == ["96"]
    assert query["GUAC_TIMEZONE"] == ["UTC"]
    assert query["GUAC_AUDIO"] == ["audio/L8", "audio/L16"]
    assert query["GUAC_IMAGE"] == ["image/png", "image/jpeg", "image/webp"]
    # `encodeURIComponent`, not form encoding: a connection name with a space must not
    # arrive as `+`, which is a different connection name and an unrecognised token.
    assert "GUAC_ID=OnTrak%20%2342" in url


def test_the_tunnel_url_follows_the_console_scheme(settings):
    assert guac.tunnel_url("https://range:8443/guacamole/", token="t", connection_id="c").startswith(
        "wss://range:8443/guacamole/websocket-tunnel?"
    )
    # A base without its trailing slash is the same console, not a different URL.
    assert guac.tunnel_url("https://range:8443/guacamole", token="t", connection_id="c").startswith(
        "wss://range:8443/guacamole/websocket-tunnel?"
    )


def test_the_tunnel_url_refuses_a_base_that_is_not_a_url(settings):
    with pytest.raises(guac.GuacError, match="http://"):
        guac.tunnel_url("guac.test/guacamole/", token="t", connection_id="c")


def test_the_tunnel_check_reports_what_guacd_painted(settings):
    tunnel = FakeTunnel(
        wire("", TUNNEL_UUID),
        # One frame, three instructions: how a real range sends a terminal's first paint.
        wire("size", "0", "1024", "768") + wire("img", "1", "0", "0", "0", "14") + wire("sync", "1", "0"),
    )
    report = guac.drive_tunnel("ws://guac.test/guacamole/websocket-tunnel", seconds=5, connect=tunnel)
    assert report.opened and report.uuid == TUNNEL_UUID
    assert report.subprotocol == "guacamole"
    assert report.opcodes == {"size": 1, "img": 1, "sync": 1}
    assert report.instructions == 3 and report.errors == []
    # The tunnel's own UUID is bookkeeping, not something the console painted.
    assert "size" in report.opcode_summary and "<internal>" not in report.opcode_summary
    # The upgrade has a deadline of its own, and a generous one: one measured on a real
    # range took longer than eight seconds, and a check that gives up sooner than a browser
    # is the thing that is wrong.
    assert tunnel.timeout == guac.TUNNEL_OPEN_SECONDS >= 10


def test_the_tunnel_check_stops_at_an_error_without_waiting_out_its_window(settings):
    """`ontrak doctor` runs this on every host: a bad answer must not cost the window."""
    tunnel = FakeTunnel(
        wire("", TUNNEL_UUID),
        wire("error", "Server refused connection (wrong security type?)", "519"),
    )
    report = guac.drive_tunnel("ws://guac.test/guacamole/websocket-tunnel", seconds=30, connect=tunnel)
    assert report.error_text == "Server refused connection (wrong security type?)"
    assert tunnel.asked_after_draining == 0


def test_the_tunnel_check_waits_past_the_handshake_for_a_paint(settings):
    """An RDP console says `cursor`, `mouse` and `sync` before it has drawn anything.

    Measured against a real Windows guest: guacd sends those three first, and sends its own
    `error` *after* them when the login or the guest is bad. A check that took the first
    instruction as its answer could not tell a desktop from a refused password — so it keeps
    reading until something is painted or something goes wrong.
    """
    tunnel = FakeTunnel(
        wire("", TUNNEL_UUID),
        wire("cursor", "0", "0", "-2", "0", "0", "64", "64") + wire("mouse", "0", "0", "0", "1") + wire("sync", "1", "0"),
        wire("img", "1", "0", "0", "0", "14") + wire("blob", "1", "AAAA") + wire("end", "1"),
    )
    report = guac.drive_tunnel("ws://guac.test/guacamole/websocket-tunnel", seconds=30, connect=tunnel)
    assert "img" in report.opcodes, "the check answered at the handshake, before any paint"
    assert "cursor" in report.opcodes and "sync" in report.opcodes
    assert tunnel.asked_after_draining == 0


def test_the_tunnel_check_keeps_the_connection_alive_the_way_a_browser_does(settings, monkeypatch):
    """Measured against a real Windows guest: guacd sends `nop` after ten seconds of hearing
    nothing from the client, again at fifteen, and then aborts the connection with status
    776 — "Aborted. See logs." `Guacamole.Client` answers by sending its own `nop` every
    five seconds, so a check that listened in silence would let a slow first frame be ended
    by its own silence and then report the console as broken. `nop` is a no-op, and it is
    the only thing a check ever sends.
    """
    monkeypatch.setattr(guac, "KEEPALIVE_SECONDS", 0.05)
    tunnel = FakeTunnel(wire("", TUNNEL_UUID))
    report = guac.drive_tunnel("ws://guac.test/guacamole/websocket-tunnel", seconds=0.3, connect=tunnel)
    assert report.opened and not report.instructions, "this test is about the quiet case"
    assert tunnel.sent, "the check listened in silence"
    assert set(tunnel.sent) == {guac.LIVENESS_REPLY}, "a check sent something of its own"


def test_a_tunnel_that_paints_is_sent_nothing_at_all(settings):
    tunnel = FakeTunnel(wire("", TUNNEL_UUID), wire("img", "1", "0", "0", "0", "14"))
    guac.drive_tunnel("ws://guac.test/guacamole/websocket-tunnel", seconds=0.3, connect=tunnel)
    assert tunnel.sent == []


def test_the_tunnel_check_reports_a_handshake_that_never_happened(settings):
    tunnel = FakeTunnel(handshake_fails=OSError("Connection refused"))
    report = guac.drive_tunnel("ws://guac.test/guacamole/websocket-tunnel", seconds=5, connect=tunnel)
    assert not report.opened
    assert "could not open the console tunnel" in report.closed
    assert "Connection refused" in report.closed


def _probe_fakes(*frames, **kwargs):
    """The probe's two HTTP steps (as real ones answer) and then the tunnel."""
    tunnel = FakeTunnel(*frames, **kwargs)

    def post(url, fields, timeout):
        return 200, '{"authToken":"tok-1","dataSource":"json"}'

    def get(url, timeout):
        return 200, '{"OnTrak doctor":{"name":"OnTrak doctor","identifier":"OnTrak doctor","protocol":"rdp"}}'

    return tunnel, post, get


def test_the_tunnel_probe_opens_the_connection_it_signed(settings):
    """A placeholder connection with nothing behind it is the *expected* failure.

    guacd answers an RDP connection to 127.0.0.1 with its own error — status 519, upstream
    unavailable, as a real range does — and that answer is the whole proof: the token
    worked, the WebSocket upgraded, the subprotocol was negotiated, and guacd was there to
    say no.
    """
    tunnel, post, get = _probe_fakes(
        wire("", TUNNEL_UUID),
        wire("error", "Server refused connection (wrong security type?)", "519"),
    )
    state, detail = guac.probe_tunnel(settings, post=post, get=get, connect=tunnel)
    assert state == "ok", detail
    assert "expected" in detail and "Server refused connection" in detail
    assert tunnel.url.startswith("ws://guac.test/guacamole/websocket-tunnel?")
    # Addressed by the *identifier* the gateway listed it under, which is what the
    # browser sends next.
    assert "GUAC_ID=OnTrak%20doctor" in tunnel.url


def test_the_tunnel_probe_catches_a_webapp_with_no_guacd_behind_it(settings):
    """With guacd stopped the tunnel upgrades and then says nothing at all.

    No UUID, no error, no close: the webapp had nowhere to send it. From the student's
    side that is a console iframe that never paints, on a stack where the gateway accepts
    every link and lists every connection.
    """
    tunnel, post, get = _probe_fakes()
    # A short window: nothing arrives at all, so the check waits it out.
    state, detail = guac.probe_tunnel(settings, post=post, get=get, connect=tunnel, seconds=0.2)
    assert state == "unreachable"
    assert "guacd" in detail and "UUID" in detail


def test_the_tunnel_probe_flags_a_dropped_subprotocol(settings):
    """A gateway that strips `Sec-WebSocket-Protocol` still serves a console, slowly."""
    tunnel, post, get = _probe_fakes(
        wire("", TUNNEL_UUID), wire("sync", "1", "0"), subprotocol=""
    )
    # `sync` alone is not a paint: the check keeps listening to its deadline here.
    state, detail = guac.probe_tunnel(settings, post=post, get=get, connect=tunnel, seconds=0.2)
    assert state == "degraded"
    assert "subprotocol" in detail and "HTTP tunnel" in detail


def test_the_tunnel_probe_skips_an_auto_console(settings):
    settings.guac.base_url = "auto"
    state, detail = guac.probe_tunnel(
        settings,
        post=lambda *a: (_ for _ in ()).throw(AssertionError()),
        get=lambda *a: (_ for _ in ()).throw(AssertionError()),
        connect=FakeTunnel(),
    )
    assert state == "skipped"
    assert "auto" in detail


def test_the_tunnel_probe_names_the_package_it_needs(settings, monkeypatch):
    """A host without the WebSocket client still gets every other check."""
    monkeypatch.setitem(sys.modules, "websockets.sync.client", None)
    tunnel, post, get = _probe_fakes(wire("", TUNNEL_UUID))
    state, detail = guac.probe_tunnel(settings, post=post, get=get, connect=None)
    assert state == "skipped"
    assert "websockets" in detail and "requirements.txt" in detail


def _session_fakes(session, scenario, *frames, **kwargs):
    """The three requests for one session, as the gateway answers them."""
    name = guac.connection_name(session, scenario)
    tunnel = FakeTunnel(*frames, **kwargs)

    def post(url, fields, timeout):
        return 200, '{"authToken":"tok-1","dataSource":"json"}'

    def get(url, timeout):
        return 200, json.dumps({name: {"name": name, "identifier": name, "protocol": "ssh"}})

    return tunnel, post, get


def test_the_session_check_reports_a_console_that_painted(settings):
    """The end-to-end promise for one machine: its own signed link paints."""
    settings.guac.linux_ssh = True
    session = make_session()
    scenario = _Scenario("linux")
    tunnel, post, get = _session_fakes(
        session,
        scenario,
        wire("", TUNNEL_UUID),
        wire("size", "0", "1024", "768") + wire("img", "1", "0", "0", "0", "14") + wire("sync", "1", "0"),
    )
    state, detail, report = guac.verify_session_console(
        settings, session, scenario, post=post, get=get, connect=tunnel
    )
    assert state == "ok", detail
    assert report.instructions == 3
    assert "guacd painted" in detail
    assert f"GUAC_ID={quote(guac.connection_name(session, scenario))}" in tunnel.url


def test_the_session_check_reports_guacd_refusing_the_login(settings):
    """What a console with an sshd and a wrong password looks like from here."""
    settings.guac.linux_ssh = True
    scenario = _Scenario("linux")
    tunnel, post, get = _session_fakes(
        make_session(), scenario, wire("", TUNNEL_UUID), wire("error", "Unable to authenticate", "769")
    )
    state, detail, _report = guac.verify_session_console(
        settings, make_session(), scenario, post=post, get=get, connect=tunnel
    )
    assert state == "error"
    assert "Unable to authenticate" in detail


def test_the_session_check_catches_a_login_that_fails_after_the_handshake(settings):
    """The RDP shape, and the reason the check does not stop at the first instruction.

    guacd connects, syncs and only then reports that the guest or the credentials were
    refused. Reading one instruction and answering "ok" would call a console that never
    paints a healthy one.
    """
    tunnel, post, get = _session_fakes(
        make_session(),
        _Scenario("windows"),
        wire("", TUNNEL_UUID),
        wire("cursor", "0", "0", "-2", "0", "0", "64", "64") + wire("sync", "1", "0"),
        wire("error", "Authentication failed", "769"),
    )
    state, detail, _report = guac.verify_session_console(
        settings, make_session(), _Scenario("windows"), post=post, get=get, connect=tunnel
    )
    assert state == "error"
    assert "Authentication failed" in detail


def test_the_session_check_skips_a_scenario_with_no_console(settings):
    # The suite's own default: `guac.linux_ssh` off means a Linux ticket has no browser
    # console at all, and the honest answer is to say that rather than to open one.
    state, detail, _report = guac.verify_session_console(
        settings,
        make_session(),
        _Scenario("linux"),
        post=lambda *a: (_ for _ in ()).throw(AssertionError()),
        get=lambda *a: (_ for _ in ()).throw(AssertionError()),
        connect=FakeTunnel(),
    )
    assert state == "skipped"
    assert "guac.linux_ssh" in detail


def test_the_session_check_refuses_a_session_with_no_machine(settings):
    settings.guac.linux_ssh = True
    state, detail, _report = guac.verify_session_console(
        settings, make_session(host_ip=""), _Scenario("linux"), connect=FakeTunnel()
    )
    assert state == "refused"
    assert "no machine address" in detail


def test_the_console_sweep_takes_what_it_was_asked_for(repo):
    """`--linux` is the sweep that fits a host: the catalogue, minus the VMs."""
    every = [scenario.id for scenario in repo.list()]
    linux = [scenario.id for scenario in repo.list() if scenario.is_linux]
    windows = [scenario_id for scenario_id in every if scenario_id not in linux]
    assert windows, "the catalogue is meant to hold both kinds of scenario"
    assert _console_targets(repo, linux[:2]) == linux[:2]
    assert _console_targets(repo, [], all_scenarios=True) == every
    assert _console_targets(repo, [], linux_only=True) == linux
    # A Windows scenario named to a Linux sweep is dropped, not silently opened.
    assert _console_targets(repo, windows[:1], linux_only=True) == []
    # ...and asking for nothing is not the same as asking for everything.
    assert _console_targets(repo, []) == []
