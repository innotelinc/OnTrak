from __future__ import annotations

import base64
import hashlib
import hmac
import json
import shutil
import subprocess
import time
from urllib.parse import parse_qs, urlparse

import pytest

from ontrak import guac
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
