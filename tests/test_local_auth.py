"""Local sign-in, and the admin toggle that makes SSO optional.

SSO is off by default, so this is the posture of a fresh range: accounts live in
the portal database, a password opens them, and an identity provider is not
needed at all. The Authentik half lives in tests/test_oidc.py.
"""

from __future__ import annotations

import pytest

from ontrak import auth, oidc
from ontrak.guest import NullDriver

from .conftest import TestClient, csrf, login

SSO = {
    "provider": "Authentik",
    "issuerHost": "",
    "configured": False,
    "enabled": False,
    "active": False,
    "misconfigured": False,
}

PASSWORD = "Correct-Horse-9"


# --------------------------------------------------------------------------- #
# the hash
# --------------------------------------------------------------------------- #
def test_a_password_hash_round_trips_and_rejects_everything_else():
    stored = auth.hash_password(PASSWORD)
    assert auth.is_local_account(stored)
    assert auth.verify_password(PASSWORD, stored)
    assert not auth.verify_password("wrong", stored)
    assert not auth.verify_password("", stored)


def test_the_sso_sentinel_is_never_a_credential():
    """An Authentik row must stay unopenable by the password form."""
    assert not auth.is_local_account(auth.ACCOUNT_SENTINEL)
    assert not auth.verify_password(PASSWORD, auth.ACCOUNT_SENTINEL)
    assert not auth.verify_password(PASSWORD, None)


def test_the_same_password_hashes_differently_every_time():
    assert auth.hash_password(PASSWORD) != auth.hash_password(PASSWORD)


def test_a_corrupt_hash_fails_closed():
    for broken in ("pbkdf2_sha256$nope$x$y", "pbkdf2_sha256$1000$zz$zz", "pbkdf2_sha256$"):
        assert not auth.verify_password(PASSWORD, broken)


# --------------------------------------------------------------------------- #
# the store
# --------------------------------------------------------------------------- #
def test_creating_a_local_account_counts_and_verifies(store):
    assert store.count_local_accounts() == 0
    store.create_local_user("alice", PASSWORD, role="student", display_name="Alice A")
    assert store.count_local_accounts() == 1
    row = store.get_user("alice")
    assert row["role"] == "student"
    assert auth.verify_password(PASSWORD, row["password_hash"])


def test_setting_a_password_changes_what_opens_the_account(store):
    store.create_local_user("alice", PASSWORD)
    assert store.set_user_password("alice", "Another-Password-1")
    row = store.get_user("alice")
    assert auth.verify_password("Another-Password-1", row["password_hash"])
    assert not auth.verify_password(PASSWORD, row["password_hash"])


def test_setting_a_password_without_an_account_says_so(store):
    assert not store.set_user_password("nobody", PASSWORD)


def test_seeding_an_account_does_not_strip_its_local_password(store):
    """upsert_user is the SSO path; it must not wipe a real credential."""
    store.create_local_user("alice", PASSWORD)
    store.upsert_user("alice", "instructor", "Alice A")
    row = store.get_user("alice")
    assert auth.verify_password(PASSWORD, row["password_hash"])
    assert row["role"] == "instructor"


# --------------------------------------------------------------------------- #
# the admin toggle
# --------------------------------------------------------------------------- #
def test_the_toggle_is_off_until_something_switches_it(settings, store):
    assert oidc.toggle(store, settings.portal) is False
    assert oidc.active(store, settings.portal) is False


def test_the_config_value_only_seeds_the_toggle(settings, store):
    settings.portal.sso_enabled = True
    assert oidc.toggle(store, settings.portal) is True
    oidc.set_toggle(store, False)
    assert oidc.toggle(store, settings.portal) is False
    # The database wins from here on, whatever the config file says.
    settings.portal.sso_enabled = True
    assert oidc.toggle(store, settings.portal) is False


def test_switching_sso_on_needs_a_configured_provider(settings, store):
    oidc.set_toggle(store, True)
    assert oidc.active(store, settings.portal) is False


# --------------------------------------------------------------------------- #
# the portal, signing in locally
# --------------------------------------------------------------------------- #
@pytest.fixture
def local_env(settings, incus):
    """The default range: SSO off, no identity provider, local accounts only."""
    if TestClient is None:  # pragma: no cover - exercised only without fastapi
        pytest.skip("fastapi/httpx not installed")
    from ontrak.portal.app import create_app

    settings.portal.sso_enabled = False
    app = create_app(settings, incus=incus, driver=NullDriver(settings, responses={}))
    with TestClient(app) as client:
        yield client, app


def test_a_fresh_range_offers_the_first_account_page(local_env):
    client, _ = local_env
    page = client.get("/login")
    assert page.status_code == 200
    assert "Set up this range" in page.text
    assert 'name="password"' not in page.text  # no accounts, so no form to fill
    assert client.get("/setup").status_code == 200


def test_the_first_account_is_an_instructor_and_opens_the_door(local_env):
    client, app = local_env
    client.get("/login")  # mints the CSRF cookie, as a browser would
    created = client.post(
        "/setup",
        data={
            "username": "boss",
            "display_name": "Boss",
            "password": PASSWORD,
            "confirm": PASSWORD,
            "csrf": csrf(client),
        },
        follow_redirects=False,
    )
    assert created.status_code == 303
    assert created.headers["location"] == "/dashboard"
    row = app.state.store.get_user("boss")
    assert row["role"] == "instructor"
    assert client.get("/dashboard").status_code == 200
    # And the page that made it is closed for good.
    client.cookies.clear()
    assert client.get("/setup", follow_redirects=False).headers["location"] == "/login"


def test_the_setup_page_refuses_a_second_account(local_env):
    client, app = local_env
    app.state.store.create_local_user("boss", PASSWORD, role="instructor")
    assert client.get("/setup", follow_redirects=False).headers["location"] == "/login"


def test_a_password_opens_its_own_account(local_env):
    client, app = local_env
    app.state.store.create_local_user("alice", PASSWORD, role="student", display_name="Alice A")
    client.get("/login")
    entered = client.post(
        "/login",
        data={"username": "alice", "password": PASSWORD, "csrf": csrf(client)},
        follow_redirects=False,
    )
    assert entered.status_code == 303
    assert entered.headers["location"] == "/dashboard"
    assert client.get("/dashboard").status_code == 200


def test_a_wrong_password_gets_no_session(local_env):
    client, app = local_env
    app.state.store.create_local_user("alice", PASSWORD)
    client.get("/login")
    refused = client.post(
        "/login",
        data={"username": "alice", "password": "not-it", "csrf": csrf(client)},
        follow_redirects=False,
    )
    assert refused.status_code == 303
    assert refused.headers["location"] == "/login"
    assert client.cookies.get("ontrak_session") is None


def test_an_unknown_username_is_refused_the_same_way(local_env):
    client, _ = local_env
    client.get("/login")
    refused = client.post(
        "/login",
        data={"username": "nobody", "password": PASSWORD, "csrf": csrf(client)},
        follow_redirects=False,
    )
    assert refused.headers["location"] == "/login"
    assert client.cookies.get("ontrak_session") is None


def test_a_disabled_account_cannot_sign_in(local_env):
    client, app = local_env
    app.state.store.create_local_user("alice", PASSWORD)
    app.state.store.deactivate_user("alice")
    client.get("/login")
    refused = client.post(
        "/login",
        data={"username": "alice", "password": PASSWORD, "csrf": csrf(client)},
        follow_redirects=False,
    )
    assert refused.headers["location"] == "/login"
    assert client.cookies.get("ontrak_session") is None


def test_a_local_form_is_also_offered_once_an_account_exists_under_sso(
    settings, store, incus
):
    """The local account is the operator's break-glass for an SSO outage."""
    if TestClient is None:  # pragma: no cover
        pytest.skip("fastapi/httpx not installed")
    from ontrak.portal.app import create_app

    settings.portal.oidc_issuer = "https://auth.example.invalid/application/o/ontrak/"
    settings.portal.oidc_client_id = "ontrak"
    settings.portal.oidc_client_secret = "secret"
    settings.portal.oidc_redirect_uri = "https://ontrak.example/oidc/callback"
    settings.portal.sso_enabled = True
    store.create_local_user("boss", PASSWORD, role="instructor")
    app = create_app(settings, incus=incus, driver=NullDriver(settings, responses={}))
    with TestClient(app) as client:
        page = client.get("/login")
        assert "Sign in with Authentik" in page.text
        assert 'name="password"' in page.text


def test_an_unconfigured_provider_switched_on_says_so(settings, store, incus):
    """Switched on with a value missing is reported, not a dead button."""
    if TestClient is None:  # pragma: no cover
        pytest.skip("fastapi/httpx not installed")
    from ontrak.portal.app import create_app

    settings.portal.sso_enabled = True  # but nothing is configured
    store.create_local_user("boss", PASSWORD, role="instructor")
    app = create_app(settings, incus=incus, driver=NullDriver(settings, responses={}))
    with TestClient(app) as client:
        page = client.get("/login")
        assert "switched on but not set up" in page.text
        assert client.get("/oidc/login", follow_redirects=False).headers["location"] == "/login"


def test_a_provisioned_range_with_sso_off_never_opens_setup(settings, store, incus):
    """An operator's range must not become anyone's account-creation page."""
    if TestClient is None:  # pragma: no cover
        pytest.skip("fastapi/httpx not installed")
    from ontrak.portal.app import create_app

    settings.portal.oidc_issuer = "https://auth.example.invalid/application/o/ontrak/"
    settings.portal.oidc_client_id = "ontrak"
    settings.portal.oidc_client_secret = "secret"
    settings.portal.oidc_redirect_uri = "https://ontrak.example/oidc/callback"
    settings.portal.sso_enabled = False  # switched off, no local account
    app = create_app(settings, incus=incus, driver=NullDriver(settings, responses={}))
    with TestClient(app) as client:
        assert "No way in" in client.get("/login").text
        assert client.get("/setup", follow_redirects=False).headers["location"] == "/login"


# --------------------------------------------------------------------------- #
# the unattended bootstrap
# --------------------------------------------------------------------------- #
def test_the_admin_password_from_config_seeds_an_instructor(settings, store, incus):
    if TestClient is None:  # pragma: no cover
        pytest.skip("fastapi/httpx not installed")
    from ontrak.portal.app import create_app

    settings.portal.admin_username = "rangeboss"
    settings.portal.admin_password = PASSWORD
    app = create_app(settings, incus=incus, driver=NullDriver(settings, responses={}))
    row = app.state.store.get_user("rangeboss")
    assert row is not None and row["role"] == "instructor"
    assert auth.verify_password(PASSWORD, row["password_hash"])
    assert app.state.store.count_local_accounts() == 1


def test_the_bootstrap_never_resets_a_changed_password(settings, store, incus):
    if TestClient is None:  # pragma: no cover
        pytest.skip("fastapi/httpx not installed")
    from ontrak.portal.app import create_app

    settings.portal.admin_username = "rangeboss"
    settings.portal.admin_password = PASSWORD
    create_app(settings, incus=incus, driver=NullDriver(settings, responses={}))
    store.create_local_user("rangeboss", "Changed-By-Hand-77", role="instructor")
    app = create_app(settings, incus=incus, driver=NullDriver(settings, responses={}))
    row = app.state.store.get_user("rangeboss")
    assert auth.verify_password("Changed-By-Hand-77", row["password_hash"])
    assert not auth.verify_password(PASSWORD, row["password_hash"])


# --------------------------------------------------------------------------- #
# the admin panel
# --------------------------------------------------------------------------- #
def test_the_sign_in_page_renders_the_toggle(local_env):
    client, app = local_env
    app.state.store.create_local_user("boss", PASSWORD, role="instructor")
    login(client, "boss")
    page = client.get("/admin/signin")
    assert page.status_code == 200
    assert "Switch SSO on" in page.text
    assert "Local accounts" in page.text


def test_the_admin_panel_refuses_to_switch_sso_on_when_nothing_is_set(
    local_env, settings
):
    client, app = local_env
    app.state.store.create_local_user("boss", PASSWORD, role="instructor")
    login(client, "boss")
    result = client.post(
        "/admin/signin",
        data={"action": "enable", "csrf": csrf(client)},
        follow_redirects=False,
    )
    assert result.status_code == 303
    assert oidc.toggle(app.state.store, settings.portal) is False


def test_the_admin_panel_switches_sso_on_once_it_is_configured(local_env, settings):
    client, app = local_env
    settings.portal.oidc_issuer = "https://auth.example.invalid/application/o/ontrak/"
    settings.portal.oidc_client_id = "ontrak"
    settings.portal.oidc_client_secret = "secret"
    settings.portal.oidc_redirect_uri = "https://ontrak.example/oidc/callback"
    app.state.store.create_local_user("boss", PASSWORD, role="instructor")
    login(client, "boss")
    client.post("/admin/signin", data={"action": "enable", "csrf": csrf(client)})
    assert oidc.active(app.state.store, settings.portal) is True
    assert "Sign in with Authentik" in client.get("/login").text


def test_the_admin_panel_refuses_to_lock_a_range_out(app_env, settings):
    """Switching SSO off with no local account would leave nobody able to enter."""
    client, app = app_env
    login(client, "teacher")
    client.post("/admin/signin", data={"action": "disable", "csrf": csrf(client)})
    assert oidc.active(app.state.store, settings.portal) is True


def test_the_admin_panel_creates_an_account_that_can_sign_in(local_env):
    client, app = local_env
    app.state.store.create_local_user("boss", PASSWORD, role="instructor")
    login(client, "boss")
    created = client.post(
        "/admin/users",
        data={
            "action": "create",
            "username": "alice",
            "display_name": "Alice A",
            "role": "student",
            "password": PASSWORD,
            "csrf": csrf(client),
        },
        follow_redirects=False,
    )
    assert created.status_code == 303
    row = app.state.store.get_user("alice")
    assert row["role"] == "student"
    assert auth.verify_password(PASSWORD, row["password_hash"])


def test_the_admin_panel_refuses_a_short_password(local_env):
    client, app = local_env
    app.state.store.create_local_user("boss", PASSWORD, role="instructor")
    login(client, "boss")
    client.post(
        "/admin/users",
        data={
            "action": "create",
            "username": "alice",
            "role": "student",
            "password": "short",
            "csrf": csrf(client),
        },
    )
    assert app.state.store.get_user("alice") is None


def test_the_admin_panel_sets_a_password_on_an_existing_account(local_env):
    client, app = local_env
    app.state.store.create_local_user("boss", PASSWORD, role="instructor")
    app.state.store.upsert_user("alice", "student", "Alice A")
    login(client, "boss")
    client.post(
        "/admin/users",
        data={"action": "password", "username": "alice", "password": "New-Password-1", "csrf": csrf(client)},
    )
    row = app.state.store.get_user("alice")
    assert auth.verify_password("New-Password-1", row["password_hash"])
