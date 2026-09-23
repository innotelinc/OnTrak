"""Student and instructor portal.

Design notes:

* Provisioning takes tens of seconds (clone + Windows boot + transport
  handshake), so it runs in a worker thread and the session page polls a small
  JSON endpoint. A web request never blocks on a boot.
* The console is an iframe pointing at Guacamole with a signed, encrypted,
  short-lived payload scoped to one VM. The student never sees an RDP password,
  and the RDP port is never exposed to the student's browser.
* Sessions are claimed for use on page load, which doubles as the activity
  heartbeat the reaper uses to reclaim abandoned VMs.
"""

from __future__ import annotations

import contextlib
import csv
import io
import secrets
import threading
import time
from pathlib import Path

from fastapi import Depends, FastAPI, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .. import auth, guac, maintenance, oidc, selection
from ..catalog import Catalog
from ..config import Settings, load_settings
from ..guest import build_driver
from ..incus import IncusClient
from ..lessons import LessonError, LessonRepository
from ..models import SessionState
from ..scenarios import ScenarioError, ScenarioRepository
from ..sessions import SessionError, SessionManager
from ..store import Store
from ..tickets import WRITEUP_ACTION, missing_required
from ..tickets import render_feedback as ticket_feedback
from .admin import AdminContext, register_admin_routes

HERE = Path(__file__).resolve().parent
templates = Jinja2Templates(directory=str(HERE / "templates"))
CSRF_COOKIE = "ontrak_csrf"
FLASH_COOKIE = "ontrak_flash"

# How long a console-gateway verdict is reused. The check is one POST to the gateway,
# and the answer only changes when an operator restarts it, so a page render must not
# pay for it every time — but a minute is short enough that a fixed gateway stops
# being reported almost immediately.
CONSOLE_GATEWAY_TTL_SECONDS = 60.0

# The floor a locally-set password has to clear; the rule lives with the hashing,
# and the admin panel imports it from there too, so the form and the check agree.
MIN_PASSWORD_LENGTH = auth.MIN_PASSWORD_LENGTH

# Hashed once, at import, so a sign-in for a username that does not exist still pays
# the full PBKDF2 cost: response time must not be the way to learn which accounts do.
_DUMMY_PASSWORD_HASH = auth.hash_password(secrets.token_hex(32))


def _valid_username(username: str) -> bool:
    """A username the range can key on: letters, digits, dot, dash, underscore."""
    return bool(username) and all(char.isalnum() or char in "._-" for char in username)


def _seed_bootstrap_admin(store, settings) -> None:
    """Create the instructor config names, if the range has no way in yet.

    `ONTRAK_PORTAL__ADMIN_PASSWORD` is the unattended equivalent of the `/setup`
    page: a container can be handed an admin password and come up ready with no
    browser, which is what makes the Docker path work with SSO off. It never
    touches a range that already has a local account, so it cannot reset a password
    an instructor has since set.
    """
    password = (settings.portal.admin_password or "").strip()
    if not password or store.count_local_accounts() > 0:
        return
    username = (settings.portal.admin_username or "admin").strip().lower() or "admin"
    store.create_local_user(
        username, password, role="instructor", display_name="Range administrator"
    )
    store.log_event(
        "setup", f"bootstrap instructor {username} from ONTRAK_PORTAL__ADMIN_PASSWORD"
    )


# ---------------------------------------------------------------------------
# request helpers
# ---------------------------------------------------------------------------
def catalog_entry(catalog: Catalog, entry_id: str):
    """Look up a catalog entry without letting a stale id break a page."""
    if not entry_id:
        return None
    try:
        return catalog.get(entry_id)
    except Exception:  # noqa: BLE001 - the console must still render
        return None


def lesson_index(lessons: LessonRepository, platform: str | None = None) -> list[dict]:
    """Lesson summaries for the index page, newest-skill-last within a platform."""
    out = []
    for lesson in lessons.list():
        if platform and lesson.platform != platform:
            continue
        out.append(
            {
                "id": lesson.id,
                "title": lesson.title,
                "summary": lesson.summary,
                "platform": lesson.platform,
                "category": lesson.category,
                "difficulty": lesson.difficulty,
                "minutes": lesson.minutes,
                "commands": len(lesson.commands),
                "exercises": len(lesson.exercises),
                "tags": list(lesson.tags),
                "prerequisites": list(lesson.prerequisites),
            }
        )
    return out


def _workload_groups(catalog: Catalog) -> list[dict]:
    """Grouped, portal-safe view of the workloads a student can pick."""
    groups = []
    for group in catalog.group_list():
        entries = [entry.to_public() for entry in group.entries]
        if entries:
            groups.append(
                {
                    "id": group.id,
                    "label": group.label,
                    "era": group.era,
                    "entries": entries,
                }
            )
    return groups


def _settings(request: Request) -> Settings:
    return request.app.state.settings


def current_user(request: Request):
    """Return the sqlite Row for the logged-in user, or None."""
    settings = _settings(request)
    payload = auth.read_cookie(request.cookies.get(auth.COOKIE_NAME), settings.portal.secret)
    if not payload:
        return None
    return request.app.state.store.get_user(payload.get("username", ""))


def require_user(request: Request):
    user = current_user(request)
    if user is None:
        raise HTTPException(status_code=303, headers={"Location": "/login"})
    return user


def require_instructor(request: Request):
    user = require_user(request)
    if user["role"] != "instructor":
        raise HTTPException(status_code=403, detail="instructor role required")
    return user


def _csrf_token(request: Request) -> str:
    token = request.cookies.get(CSRF_COOKIE) or secrets.token_urlsafe(24)
    request.state.csrf = token
    return token


def _check_csrf(request: Request, submitted: str) -> None:
    expected = request.cookies.get(CSRF_COOKIE)
    if not expected or not submitted or not secrets.compare_digest(expected, submitted):
        raise HTTPException(status_code=400, detail="invalid form token; reload the page")


def _pop_flash(request: Request) -> str:
    settings = _settings(request)
    payload = auth.read_cookie(request.cookies.get(FLASH_COOKIE), settings.portal.secret)
    return (payload or {}).get("m", "")


def _set_flash(response, request: Request, message: str) -> None:
    settings = _settings(request)
    response.set_cookie(
        FLASH_COOKIE,
        auth.sign_cookie({"m": message}, settings.portal.secret, ttl_seconds=120),
        httponly=True,
        samesite="lax",
    )


def render(request: Request, template: str, context: dict, status_code: int = 200):
    """Render a page with the chrome every page needs."""
    settings = _settings(request)
    csrf = getattr(request.state, "csrf", None) or _csrf_token(request)
    body = {
        "request": request,
        "title": settings.portal.title,
        "brand_note": settings.portal.brand_note,
        "user": current_user(request),
        "csrf": csrf,
        "flash": _pop_flash(request),
        **context,
    }
    response = templates.TemplateResponse(request, template, body, status_code=status_code)
    response.set_cookie(CSRF_COOKIE, csrf, httponly=True, samesite="lax", max_age=12 * 3600)
    response.delete_cookie(FLASH_COOKIE)
    return response


def redirect(path: str, request: Request, message: str = "", status_code: int = 303):
    response = RedirectResponse(path, status_code=status_code)
    if message:
        _set_flash(response, request, message)
    return response


def _session_link(request: Request, session) -> str:
    """Signed Guacamole URL for one session, or an empty string.

    The request is passed through so `guac.base_url: auto` (the default) can put the
    console on the same address the student used for the portal — a LAN address, a
    phone hotspot, localhost — instead of a fixed one that only works on one of them.
    """
    settings = _settings(request)
    if not session.host_ip or not settings.guac.secret_key:
        return ""
    try:
        scenario = request.app.state.repo.get(session.scenario_id)
        return guac.build_link(settings, session, scenario, request=request)
    except (guac.GuacError, ScenarioError):
        return ""


# The guests live on the lab's own bridge (10.20.0.0/24) and nothing routes to them
# from outside it. The portal is on the internet, the machines are not, so the
# browser console is the only way in from a student's own network and the address is
# an identifier for the machine rather than something to connect to. Saying so is
# not a detail: the page that handed over `10.20.0.151` as "the address above is
# still yours to connect to directly" was telling a remote student to ssh into a
# machine their network cannot reach.
LAB_NETWORK = "the lab's internal network"


def _machine_address(settings, scenario, session) -> dict:
    """What a student connects to, how, and from where it can be reached.

    A Windows guest brokers RDP on ``guest.rdp_port``; a Linux guest is a shell,
    reached over SSH on ``guest.ssh_port`` when the template runs an sshd
    (``guac.linux_ssh``) and otherwise through the Incus agent on the host. Either
    way it is a string the portal already holds, so it belongs on the page. The
    alternative - telling the student to ask their instructor - puts a person in the
    loop for every session and leaves a blank page when nobody is watching.

    ``reach`` is where that address works, and it is the same answer for every
    machine here: the lab's internal network. The address is shown so the machine is
    identified, and the console is what actually gets a student to it.
    """
    host = session.host_ip
    if not host:
        return {"host": "", "target": "", "user": "", "transport": "", "reach": LAB_NETWORK}
    if scenario.is_linux:
        user = settings.guest.linux_user or "root"
        if settings.guac.linux_ssh:
            return {"host": host,
                    "target": f"ssh {user}@{host} -p {settings.guest.ssh_port}",
                    "user": user, "transport": "SSH", "reach": LAB_NETWORK}
        # No sshd in the image: the shell is the guest's own console, not a socket.
        return {"host": host, "target": host, "user": user,
                "transport": "shell", "reach": LAB_NETWORK}
    return {"host": host,
            "target": f"{host}:{settings.guest.rdp_port}",
            "user": session.rdp_user or settings.guest.user, "transport": "RDP",
            "reach": LAB_NETWORK}


def _console_gateway_verdict(request: Request) -> tuple[str, str]:
    """Cached ``(state, detail)`` for the console gateway's key agreement.

    Why the portal asks at all: it signs every console link and never sees the
    gateway's answer, so a gateway with a different key leaves the student staring at
    an iframe that never opens, with nothing anywhere explaining it (see
    :func:`guac.probe_gateway`). Asking here turns that into a sentence on the page.
    """
    state = request.app.state
    now = time.monotonic()
    cached = state.console_gateway
    if cached is not None and now - cached[0] < CONSOLE_GATEWAY_TTL_SECONDS:
        return cached[1]
    verdict = guac.probe_gateway(_settings(request))
    state.console_gateway = (now, verdict)
    return verdict


def _provision_async(request: Request, session_id: int) -> None:
    """Kick off provisioning in a daemon thread, at most once per session."""
    state = request.app.state
    with state.provision_lock:
        if session_id in state.provisioning:
            return
        state.provisioning.add(session_id)

    def work() -> None:
        try:
            session = state.store.get_session(session_id)
            if session is not None:
                state.manager.provision(session)
        finally:
            with state.provision_lock:
                state.provisioning.discard(session_id)

    threading.Thread(target=work, name=f"provision-{session_id}", daemon=True).start()


def _start_template_sweep(manager, settings) -> threading.Thread | None:
    """Bring missing or stale templates up to date, off the request path. ``None``
    when the range has it switched off, or has no hypervisor to build on.

    A template is a snapshot, and the thing it snapshots moves: editing a scenario,
    or turning a setting that is baked into the guest on or off (``guac.linux_ssh``
    installs an sshd), leaves every existing snapshot wrong — and the symptom is a
    student's console or fault being the previous version with nothing to say why.
    Doing this at startup means a range that has just been deployed, or pulled onto
    a host, heals itself.
    """
    if not getattr(settings.session, "auto_templates", True):
        return None
    if getattr(manager, "incus", None) is None:
        return None

    def work() -> None:
        try:
            results = manager.ensure_all_templates()
        except Exception as exc:  # noqa: BLE001 - a sweep must never kill the portal
            manager.store.log_event("template_sweep_failed", str(exc))
            return
        changed = {key: value for key, value in results.items() if value != "current"}
        if changed:
            manager.store.log_event(
                "template_sweep",
                ", ".join(f"{key} {value}" for key, value in sorted(changed.items())),
            )

    thread = threading.Thread(target=work, name="ontrak-templates", daemon=True)
    thread.start()
    return thread


# ---------------------------------------------------------------------------
# app factory
# ---------------------------------------------------------------------------
def create_app(
    settings: Settings | None = None,
    incus: IncusClient | None = None,
    driver=None,
) -> FastAPI:
    """Build the ASGI app. ``incus``/``driver`` are injectable for tests."""
    settings = settings or load_settings()
    settings.ensure_dirs()

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        """Run the portal's own housekeeping for as long as the portal is up.

        A stack built by `docker compose up` has no cron, so the reaper is not run by
        anything an operator set up: the portal runs the session half of it itself
        (ontrak/maintenance.py). `app.state.manager` is read here rather than captured.

        The same thread start does the template sweep: a template is a snapshot, and
        editing a scenario or turning a setting baked into the guest leaves it stale,
        so the range brings itself up to date rather than waiting for an operator to
        remember a command. It is a daemon thread because a build boots a guest and
        can take minutes — the portal serves pages while it works.
        """
        app.state.maintenance = maintenance.start(app.state.manager, settings)
        app.state.template_sweep = _start_template_sweep(app.state.manager, settings)
        try:
            yield
        finally:
            if app.state.maintenance is not None:
                app.state.maintenance.stop()
            app.state.maintenance = None
            app.state.template_sweep = None

    app = FastAPI(
        title=settings.portal.title, docs_url=None, redoc_url=None, lifespan=lifespan
    )
    app.state.settings = settings
    app.state.store = Store(settings.db_path)
    app.state.repo = ScenarioRepository(settings.scenarios_dir)
    app.state.lessons = LessonRepository(settings.lessons_dir)
    catalog = Catalog(settings.catalog_dir)
    app.state.catalog = catalog

    if incus is None:
        incus = IncusClient(settings) if IncusClient.available() else None
    app.state.incus = incus
    app.state.manager = SessionManager(
        settings,
        app.state.store,
        repo=app.state.repo,
        incus=incus,
        driver=driver or build_driver(settings),
        catalog=catalog,
    )
    # ``(monotonic, (state, detail))`` from the last console-gateway probe, or None.
    app.state.console_gateway: tuple[float, tuple[str, str]] | None = None
    app.state.provisioning = set()
    app.state.provision_lock = threading.Lock()
    # Set by the lifespan above: the running housekeeping loop and template sweep,
    # or None.
    app.state.maintenance = None
    app.state.template_sweep = None
    # "Check my work" results are shown to the student but never persisted: the lab is
    # results-only, so only the grade submitted at Complete & End is stored. Keeping
    # the last preview in process memory is what lets the page still show feedback.
    app.state.preview_reports: dict[int, object] = {}
    # Write-up previews, same policy as the machine previews above: shown, never stored.
    app.state.preview_tickets: dict[int, object] = {}

    app.mount("/static", StaticFiles(directory=str(HERE / "static")), name="static")

    def load_session(request: Request, user, session_id: int):
        """Fetch a session the user is allowed to touch.

        Instructors may act on any session; students only on their own. This is
        the single place that decision is made, so a new endpoint cannot forget
        it and leak one student's machine (and its console) to another.
        """
        return request.app.state.manager.get_owned_session(
            user["username"], session_id, allow_instructor=user["role"] == "instructor"
        )

    # ------------------------------------------------------------------ auth --
    # Two doors, and the portal decides which are live (docs/operations.md
    # "Sign-in"): local accounts, which work with nothing else installed and are
    # the default, and Authentik SSO, which an instructor switches on in the admin
    # panel once the range has been provisioned for it. Both end here, at
    # `issue_session`, so a session is minted in exactly one place.
    def issue_session(request: Request, user, message: str = ""):
        """Issue the portal session cookie for a user row. The one place that
        does it, so the local login and the OIDC callback cannot drift apart.

        Not named ``start_session``: that is the ``/sessions/start`` handler
        defined further down this factory, and a helper of the same name is
        silently shadowed by it.
        """
        response = redirect("/dashboard", request, message or f"Signed in as {user['username']}.")
        response.set_cookie(
            auth.COOKIE_NAME,
            auth.sign_cookie(
                {"username": user["username"], "role": user["role"]},
                settings.portal.secret,
                ttl_seconds=12 * 3600,
            ),
            httponly=True,
            samesite="lax",
        )
        request.app.state.store.log_event("login", user["username"])
        return response

    # ------------------------------------------------------------ local sign-in --
    # SSO is optional and off by default, so a range with no identity provider still
    # signs people in: accounts with a password live in this database, and this is
    # their door. An SSO account row carries only a sentinel, so a password can
    # never open one (see auth.verify_password) — the SSO and local doors lead to
    # different accounts, not to the same account twice.
    def authenticate(request: Request, username: str, password: str):
        """The account row these credentials open, or None.

        An unknown username still pays the full PBKDF2 cost (the dummy hash), so
        response time does not say which accounts exist.
        """
        store = request.app.state.store
        row = store.get_user(username.strip().lower())
        stored = row["password_hash"] if row is not None else _DUMMY_PASSWORD_HASH
        if not auth.verify_password(password, stored):
            return None
        return row

    def local_accounts(request: Request) -> int:
        return request.app.state.store.count_local_accounts()

    def needs_setup(request: Request) -> bool:
        """Whether the range has no way in at all, so `/setup` is live.

        Only when SSO is switched off *and* no local account exists *and* no
        identity provider has been provisioned: that is a range that has genuinely
        never been set up, and the page closes itself for good as soon as the first
        instructor is created. A range that *is* provisioned for Authentik but has
        SSO switched off is deliberately excluded — it is a deployment with an
        operator, and an open account-creation page on it would be a way in for
        whoever finds it first. That operator has two ways back: switch the toggle
        by seeding `ONTRAK_PORTAL__SSO_ENABLED=true`, or seed a local account with
        `ONTRAK_PORTAL__ADMIN_PASSWORD`.
        """
        store = request.app.state.store
        return (
            local_accounts(request) == 0
            and not oidc.active(store, settings.portal)
            and not oidc.configured(settings.portal)
        )

    def local_login_offered(request: Request, sso: dict) -> bool:
        """Whether the password form is part of the login page.

        Exactly when there is an account a password could open. With SSO off that
        is the door; with SSO on it is still there, because a local account is the
        operator's break-glass for a provider that has stopped answering — and on a
        pure-SSO range there is none, so nothing on the page invites a password.

        A range with no accounts and no SSO does not get an empty form: with no
        provider configured it gets `/setup`, and with one it gets the message
        below (see `no_way_in`).
        """
        return local_accounts(request) > 0

    def no_way_in(request: Request, sso: dict) -> bool:
        """The one state with no door at all: SSO off, nothing to sign in with.

        A range provisioned for Authentik whose switch is off and which has no
        local account. Only an operator can end it, and only from outside the
        portal — which is why the page names the variables instead of a form.
        """
        if sso["active"] or needs_setup(request):
            return False
        return not local_login_offered(request, sso)

    @app.get("/login", response_class=HTMLResponse)
    def login_form(request: Request):
        store = request.app.state.store
        sso = oidc.public_config(settings.portal, store)
        return render(
            request,
            "login.html",
            {
                "sso": sso,
                "local_form": local_login_offered(request, sso),
                "local_accounts": store.count_local_accounts(),
                "needs_setup": needs_setup(request),
                "no_way_in": no_way_in(request, sso),
            },
        )

    @app.post("/login")
    def login_submit(
        request: Request,
        username: str = Form(""),
        password: str = Form(""),
        csrf: str = Form(""),
    ):
        """Sign in with a local account. Always present; only local rows open."""
        _check_csrf(request, csrf)
        store = request.app.state.store
        user = authenticate(request, username, password)
        if user is None:
            store.log_event("login-refused", username.strip().lower())
            return redirect("/login", request, "That username and password do not match.")
        return issue_session(
            request, user, f"Signed in as {user['display_name'] or user['username']}."
        )

    # ------------------------------------------------------------- first run --
    # A range whose SSO is off and which has no local account yet would have no way
    # in at all — local sign-in has to exist before there is anyone to sign in as.
    # So it offers exactly one page to create the first instructor, and then that
    # page refuses to render again (which is what makes it safe to leave mounted).
    @app.get("/setup", response_class=HTMLResponse)
    def setup_form(request: Request):
        if not needs_setup(request):
            return redirect("/login", request)
        return render(request, "setup.html", {})

    @app.post("/setup")
    def setup_submit(
        request: Request,
        username: str = Form(""),
        display_name: str = Form(""),
        password: str = Form(""),
        confirm: str = Form(""),
        csrf: str = Form(""),
    ):
        _check_csrf(request, csrf)
        if not needs_setup(request):
            return redirect("/login", request, "This range already has accounts — sign in instead.")
        store = request.app.state.store
        username = username.strip().lower()
        if not _valid_username(username):
            return redirect(
                "/setup", request, "Pick a username of letters, digits, dot, dash or underscore."
            )
        if password != confirm:
            return redirect("/setup", request, "The two passwords do not match.")
        if len(password) < MIN_PASSWORD_LENGTH:
            return redirect(
                "/setup", request, f"Use a password of at least {MIN_PASSWORD_LENGTH} characters."
            )
        store.create_local_user(
            username, password, role="instructor", display_name=display_name.strip()
        )
        store.log_event("setup", f"bootstrap instructor {username}")
        user = store.get_user(username)
        return issue_session(request, user, "Range created — welcome.")

    @app.get("/oidc/login")
    def oidc_start(request: Request):
        """Send the browser to Authentik."""
        if not oidc.active(request.app.state.store, settings.portal):
            return redirect("/login", request, "Single sign-on is not switched on for this range.")
        try:
            state = oidc.new_state()
            callback = oidc.callback_for(settings.portal, request.headers)
            destination = oidc.authorize_url(settings.portal, state, callback)
        except oidc.OidcError as exc:
            return redirect("/login", request, f"Sign-in is unavailable: {exc}")
        response = RedirectResponse(destination, status_code=303)
        # The state is signed, and the cookie is host-only: the callback has to
        # present it, so a flow started for one origin cannot be finished on
        # another, and a code cannot be replayed after this expires.
        response.set_cookie(
            oidc.OIDC_COOKIE,
            auth.sign_cookie(
                {"state": state, "redirect_uri": callback},
                settings.portal.secret,
                ttl_seconds=oidc.STATE_TTL_SECONDS,
            ),
            httponly=True,
            samesite="lax",
        )
        return response

    @app.get("/oidc/callback")
    def oidc_callback(request: Request, code: str = "", state: str = "", error: str = ""):
        """Authentik's return leg: exchange the code, then map claims to a role."""
        store = request.app.state.store

        def refuse(message: str):
            """Deny access in the app's own idiom: no session, and a message the
            student can read. The signed state cookie never survives a failure."""
            response = redirect("/login", request, message)
            response.delete_cookie(oidc.OIDC_COOKIE)
            return response

        if not oidc.active(store, settings.portal):
            # The switch was turned off between the redirect and the return leg.
            return refuse("Single sign-on is not switched on for this range.")
        wanted = auth.read_cookie(request.cookies.get(oidc.OIDC_COOKIE), settings.portal.secret)
        if error:
            return refuse(f"Authentik refused the sign-in: {error}")
        if not wanted or not state or wanted.get("state") != state:
            # Expired, replayed, or a callback that arrived on a different origin
            # than the sign-in started on (the state cookie is host-only).
            return refuse("That sign-in expired or was already used. Start again.")
        try:
            token = oidc.exchange_code(settings.portal, code, str(wanted.get("redirect_uri") or ""))
            claims = oidc.userinfo(settings.portal, token)
        except oidc.OidcError as exc:
            return refuse(f"Sign-in failed: {exc}")

        username = oidc.username_for(claims)
        if not username:
            return refuse(
                "Authentik returned no email address for that account — ask your instructor to set one."
            )
        if not oidc.entitled(settings.portal, claims):
            store.log_event("login-refused", username)
            return refuse("That account is not enrolled in this range.")

        # Authentik is re-read on every sign-in, so a group change takes effect on
        # the next one with nothing to keep in step locally.
        store.upsert_sso_user(
            username, display_name=oidc.display_name_for(claims, username), role=oidc.role_for(claims, settings.portal)
        )
        user = store.get_user(username)
        if user is None:
            # The row exists but is deactivated: an instructor's own control wins
            # over an SSO sign-in (see store.upsert_sso_user).
            store.log_event("login-refused", username)
            return refuse("That account is disabled on this range. Ask your instructor.")
        response = issue_session(request, user, f"Signed in as {user['display_name'] or user['username']}.")
        response.delete_cookie(oidc.OIDC_COOKIE)
        return response

    @app.post("/logout")
    def logout(request: Request, csrf: str = Form("")):
        _check_csrf(request, csrf)
        response = redirect("/login", request, "Signed out.")
        response.delete_cookie(auth.COOKIE_NAME)
        return response

    @app.get("/healthz")
    def healthz():
        return {"status": "ok", "scenarios": len(app.state.repo.list())}

    @app.get("/")
    def index(request: Request):
        return redirect("/dashboard" if current_user(request) else "/login", request)

    # ------------------------------------------------------------- dashboard --
    @app.get("/dashboard", response_class=HTMLResponse)
    def dashboard(request: Request, user=Depends(require_user)):
        store = request.app.state.store
        repo = request.app.state.repo
        my_sessions = store.list_sessions(student=user["username"], limit=25)
        grouped = repo.by_category()
        catalog = [
            {
                "category": category,
                "label": scenario_list[0].category_label,
                "scenarios": [s.public() for s in scenario_list],
            }
            for category, scenario_list in grouped.items()
        ]
        live = [s for s in my_sessions if s.state.is_live]
        workloads = _workload_groups(request.app.state.catalog)
        return render(
            request,
            "dashboard.html",
            {
                "catalog": catalog,
                "sessions": my_sessions,
                "live_ids": {s.id for s in live},
                "states": SessionState,
                "lifetime_minutes": settings.session.ttl_minutes,
                "time_limits": settings.session.time_limit_choices,
                "workloads": workloads,
                "auto_assign": settings.selection.auto_assign,
                "strategy": settings.selection.strategy,
                "results": store.results_for_student(user["username"])[:10],
                "unavailable": request.app.state.manager.unavailable_scenarios(),
            },
        )

    # -------------------------------------------------------------- sessions --
    @app.post("/sessions/start")
    def start_session(
        request: Request,
        scenario_id: str = Form(""),
        workload: str = Form(""),
        time_limit: str = Form(""),
        csrf: str = Form(""),
        user=Depends(require_user),
    ):
        _check_csrf(request, csrf)
        manager = request.app.state.manager
        settings_ = request.app.state.settings

        # "auto" (or nothing) means "surprise me": pick a scenario the settings say
        # fits, rather than making a student choose their own fault.
        if not scenario_id or scenario_id == "auto":
            if not settings_.selection.auto_assign:
                return redirect("/dashboard", request, "Choose a scenario to start.")
            history = [s.scenario_id for s in request.app.state.store.list_sessions(limit=500)]
            choice = selection.choose(
                request.app.state.repo.list(),
                history=history,
                strategy=settings_.selection.strategy,
                max_difficulty=settings_.selection.max_difficulty,
                seed=settings_.selection.seed,
            )
            scenario_id = choice.scenario.id
        limit = int(time_limit) if str(time_limit).isdigit() and int(time_limit) > 0 else None
        try:
            # Refuse a scenario this range cannot start *before* a session exists. The
            # provisioning failure is caught in a worker thread, so without this the
            # student's only clue is an `error` row carrying an operator's message —
            # a slot burned on a machine that was never going to boot.
            unavailable = manager.scenario_availability(scenario_id, workload or None)
            if unavailable:
                return redirect("/dashboard", request, unavailable)
            session = manager.create_session(
                user["username"], scenario_id, workload=workload or None, time_limit_minutes=limit
            )
        except (SessionError, ScenarioError) as exc:
            return redirect("/dashboard", request, str(exc))
        if session.state.is_usable:
            return redirect(f"/sessions/{session.id}", request, "Session resumed.")
        if session.state == SessionState.ERROR:
            return redirect(f"/sessions/{session.id}", request, session.error[:200])
        _provision_async(request, session.id)
        return redirect(f"/sessions/{session.id}", request, "Preparing your machine...")

    @app.get("/sessions/{session_id}", response_class=HTMLResponse)
    def session_page(request: Request, session_id: int, user=Depends(require_user)):
        manager = request.app.state.manager
        store = request.app.state.store
        try:
            session = load_session(request, user, session_id)
        except SessionError as exc:
            return redirect("/dashboard", request, str(exc))

        scenario = request.app.state.repo.get(session.scenario_id)
        if session.state == SessionState.READY:
            session = manager.claim_for_use(session)
        elif session.state in {SessionState.IN_USE, SessionState.PASSED}:
            manager.touch(session)

        # Stored results are final submissions only. A student's own check is shown
        # from process memory so the page still gives feedback without recording it.
        report = store.latest_report(session.id) if session.id else None
        preview = request.app.state.preview_reports.get(session.id or 0)
        # The in-house ticket: the form to fill in, whatever the student has typed so
        # far, and the mark from a preview (never from a stored submission — that is
        # what Complete & End is for).
        ticket_form = manager.ticket_form(scenario)
        ticket_answers = store.ticket_draft(session.id or 0) if ticket_form else {}
        ticket_preview = request.app.state.preview_tickets.get(session.id or 0)
        submitted_ticket = store.latest_ticket(session.id) if session.id else None
        if ticket_form is not None and submitted_ticket is not None:
            ticket_rows = ticket_feedback(ticket_form, submitted_ticket)
        elif ticket_form is not None and ticket_preview is not None:
            ticket_rows = ticket_feedback(ticket_form, ticket_preview)
        else:
            ticket_rows = []
        # The console link, plus the gateway's verdict on the key it was signed with.
        # Only asked when there is a console to show, so the probe stays off every
        # other page — and only reported when the gateway actually refused, because
        # "unreachable" is normal from a host behind a public name.
        console_url = _session_link(request, session)
        console_refused = ""
        # The one console problem that is a *deployment* choice rather than a fault: a
        # pinned guac.base_url on another origin, where the frame's stored-token clear
        # cannot reach. Say it above the console rather than letting a student wonder
        # why the machine on screen is not the one this page names.
        console_origin_warning = guac.console_origin_warning(settings, request) if console_url else ""
        if console_url:
            state_name, detail = _console_gateway_verdict(request)
            if state_name == "refused":
                console_refused = detail
        return render(
            request,
            "session.html",
            {
                "session": session,
                "scenario": scenario,
                "scenario_public": scenario.public(session.hint_level),
                "report": report,
                "preview": preview,
                "console_url": console_url,
                "console_refused": console_refused,
                "console_origin_warning": console_origin_warning,
                "address": _machine_address(settings, scenario, session),
                "events": store.events_for(session.id, limit=15) if session.id else [],
                "states": SessionState,
                "time_limits": settings.session.time_limit_choices,
                "idle_recycle_minutes": settings.session.idle_recycle_minutes,
                "workload": catalog_entry(request.app.state.catalog, session.workload),
                "workloads": _workload_groups(request.app.state.catalog),
                "ticket_form": ticket_form.public() if ticket_form else None,
                "ticket_answers": ticket_answers,
                "ticket_preview": ticket_preview,
                "ticket_rows": ticket_rows,
                "lessons": request.app.state.lessons.for_scenario(scenario.lessons),
            },
        )

    @app.get("/sessions/{session_id}/console", response_class=HTMLResponse)
    def session_console(request: Request, session_id: int, user=Depends(require_user)):
        """The page a console frame loads to open one student's machine.

        Deliberately *not* the Guacamole URL itself. Guacamole keeps its auth token in
        the browser's localStorage and re-authenticates with it on every load, and the
        gateway reuses the session that token belongs to — so a fresh, correctly signed
        payload is ignored and the console opens whatever machine that browser used
        last. A student moving from session #3 to #4 sat looking at #3's (by then
        destroyed) machine reporting "the remote desktop server has encountered an
        error", and no amount of cache-busting on the Guacamole URL could fix it.

        This page is served from the portal's own origin, which is the gateway's origin
        whenever the console is (``guac.base_url: auto``, the default and the whole
        point of a setup-anywhere lab), so it can drop that stored token first and make
        the payload we just signed the authority on which connection opens.
        """
        try:
            session = load_session(request, user, session_id)
        except SessionError as exc:
            return redirect("/dashboard", request, str(exc))
        url = _session_link(request, session)
        if not url:
            return redirect(
                f"/sessions/{session_id}",
                request,
                "There is no browser console for this machine.",
            )
        return render(
            request,
            "console.html",
            {
                "title": "Opening the console…",
                "console_url": url,
                # Only meaningful when the portal's page shares the console's origin;
                # a console served from somewhere else has storage we cannot touch.
                # The session page says so in a banner; this page only clears.
                "clear_token": guac.same_origin(url, guac.request_origin(request)),
            },
        )

    @app.get("/sessions/{session_id}/status")
    def session_status(request: Request, session_id: int, user=Depends(require_user)):
        try:
            session = load_session(request, user, session_id)
        except SessionError as exc:
            return JSONResponse({"error": str(exc)}, status_code=404)
        return JSONResponse(
            {
                "id": session.id,
                "state": session.state.value,
                "ready": session.state.is_usable,
                "host_ip": session.host_ip,
                "error": session.error,
                "checks_run": session.checks_run,
                "best_score": session.best_score,
                "resolved": session.resolved,
                "seconds_remaining": session.seconds_remaining(),
                "time_limit_minutes": session.time_limit_minutes,
                "workload": session.workload,
                "console_available": bool(_session_link(request, session)),
            }
        )

    @app.get("/sessions/{session_id}/heartbeat")
    def session_heartbeat(request: Request, session_id: int, user=Depends(require_user)):
        """The student's browser saying "still here", so the reaper does not take a busy machine.

        The idle reaper frees a machine nobody is sitting in front of, and it reads
        activity from this app — but a student works *inside the console*, which the
        gateway serves from its own upstream: nothing they do in the machine ever
        reaches the portal. So a session whose page was opened once and then left alone
        (the console is a frame *on* that page) went on looking idle, and a 45-minute
        session was destroyed `idle_20m`, twenty-one minutes in, mid-scenario, with the
        console still on screen — the machine did not fail, it was reclaimed.

        The page hosting the console beats this while it is open, and that is what
        counts as a student being there. What it deliberately does not do is revive
        anything: only a session with a machine on screen is touched, so a destroyed or
        errored row cannot be kept alive by a stale tab.

        A GET with a side effect, on purpose. A beacon must not need a CSRF token, and
        what this does — mark the session active — is exactly what rendering the session
        page already does, on the same authentication.
        """
        try:
            session = load_session(request, user, session_id)
        except SessionError as exc:
            return JSONResponse({"error": str(exc)}, status_code=404)
        if session.host_ip and not session.state.is_terminal:
            request.app.state.manager.touch(session)
        return JSONResponse(
            {
                "id": session.id,
                "state": session.state.value,
                # Whether there is still a machine on screen. A submitted session can keep
                # its machine for review (`session.destroy_on_complete: false`), and the
                # page it is showing has to know when that ends — the frame is otherwise
                # left pointing at a machine that is gone.
                "machine_up": bool(session.host_ip),
                "seconds_remaining": session.seconds_remaining(),
            }
        )

    @app.post("/sessions/{session_id}/check")
    def session_check(request: Request, session_id: int, csrf: str = Form(""), user=Depends(require_user)):
        _check_csrf(request, csrf)
        manager = request.app.state.manager
        try:
            session = load_session(request, user, session_id)
        except SessionError as exc:
            return redirect("/dashboard", request, str(exc))
        if session.state in {SessionState.REQUESTED, SessionState.ALLOCATING, SessionState.PROVISIONING}:
            return redirect(f"/sessions/{session_id}", request, "The machine is still starting up.")
        report = manager.run_checks(session)
        # Held in memory for display only: nothing about this attempt is stored.
        request.app.state.preview_reports[session_id] = report
        if report.error:
            return redirect(f"/sessions/{session_id}", request, f"Grading problem: {report.error}")
        verdict = "Resolved" if report.resolved else "Not resolved yet"
        return redirect(
            f"/sessions/{session_id}",
            request,
            f"{verdict} — {report.summary_line()} (this attempt is not recorded; "
            "use Complete & End to submit)",
        )

    @app.post("/sessions/{session_id}/ticket")
    async def session_ticket(
        request: Request, session_id: int, user=Depends(require_user)
    ):
        """Save the in-house ticket as a draft, or grade a preview of it.

        Nothing is recorded here: the written ticket is graded when the student hands
        the session in, exactly like the machine state (see the results-only policy in
        docs/architecture.md). The draft is kept so a reload does not lose the typing.
        """
        form_data = await request.form()
        _check_csrf(request, str(form_data.get("csrf") or ""))
        manager = request.app.state.manager
        try:
            session = load_session(request, user, session_id)
        except SessionError as exc:
            return redirect("/dashboard", request, str(exc))
        ticket_form = manager.ticket_form_for(session)
        if ticket_form is None:
            return redirect(f"/sessions/{session_id}", request, "This scenario has no ticket form.")
        values = {fld.id: str(form_data.get(fld.id) or "") for fld in ticket_form.fields}
        manager.save_ticket_draft(session, values)
        action = str(form_data.get(WRITEUP_ACTION) or "save")
        if action != "preview":
            return redirect(f"/sessions/{session_id}", request, "Ticket saved as a draft.")
        grade = manager.grade_ticket(session, values)
        request.app.state.preview_tickets[session_id] = grade
        if grade is None:
            return redirect(f"/sessions/{session_id}", request, "This scenario has no ticket form.")
        return redirect(
            f"/sessions/{session_id}",
            request,
            f"Write-up preview: {grade.summary_line()} (not recorded — it is marked with the "
            "machine when you complete the session).",
        )

    @app.post("/sessions/{session_id}/complete")
    async def session_complete(request: Request, session_id: int, user=Depends(require_user)):
        """Hand the session in — or save/preview the write-up, from the same form.

        The write-up lives in one HTML form with three submitting buttons (save,
        preview, hand in), because nested forms are not a thing and duplicating every
        field for a second button would be worse. ``ontrak_writeup`` decides which one
        it was — not ``action``, which is a field many scenarios define themselves (see
        ``tickets.WRITEUP_ACTION``).
        """
        form_data = await request.form()
        _check_csrf(request, str(form_data.get("csrf") or ""))
        manager = request.app.state.manager
        try:
            session = load_session(request, user, session_id)
        except SessionError as exc:
            return redirect("/dashboard", request, str(exc))
        # `is_submitted` as well as `is_terminal`: a hand-in stores one result and that
        # is the record, so a second POST — a reloaded form, a scripted retry — must not
        # grade the same session again. The page no longer offers the button; this is
        # what makes that true rather than tidy.
        if session.state.is_terminal or session.state.is_submitted:
            return redirect(f"/results?session={session_id}", request, "That session is already handed in.")

        ticket_form = manager.ticket_form_for(session)
        values = None
        if ticket_form is not None:
            values = {fld.id: str(form_data.get(fld.id) or "") for fld in ticket_form.fields}
            # Defaulting to the *non-destructive* action matters: a submission that
            # arrives without the control (scripted, or a form that lost its button)
            # must not grade and destroy the student's machine. The button is always
            # sent by a browser; only a hand-built POST lacks it.
            action = str(form_data.get(WRITEUP_ACTION) or "save")
            if action in {"save", "preview"}:
                manager.save_ticket_draft(session, values)
                if action == "save":
                    return redirect(f"/sessions/{session_id}", request, "Write-up saved as a draft.")
                preview_grade = manager.grade_ticket(session, values)
                request.app.state.preview_tickets[session_id] = preview_grade
                summary = preview_grade.summary_line() if preview_grade else "no rubric"
                return redirect(
                    f"/sessions/{session_id}",
                    request,
                    f"Write-up preview: {summary} (not recorded — it is marked with the "
                    "machine when you hand the session in).",
                )
            # A blank required field is a submit-by-mistake, not a zero: send it back so
            # the student loses nothing but a click.
            missing = missing_required(ticket_form, values)
            if missing:
                manager.save_ticket_draft(session, values)
                return redirect(
                    f"/sessions/{session_id}",
                    request,
                    "Your write-up is missing: " + ", ".join(missing) + ". Nothing was submitted.",
                )
        report = manager.complete(session, values=values)
        request.app.state.preview_reports.pop(session_id, None)
        request.app.state.preview_tickets.pop(session_id, None)
        if report.error:
            return redirect(f"/sessions/{session_id}", request, f"Could not grade: {report.error}")
        verdict = "passed" if report.resolved else "not passed"
        return redirect(
            f"/results?session={session_id}",
            request,
            f"Submitted — {report.summary_line()} ({verdict}). Your machine has been destroyed.",
        )

    @app.post("/sessions/{session_id}/limit")
    def session_limit(
        request: Request,
        session_id: int,
        minutes: int = Form(90),
        csrf: str = Form(""),
        user=Depends(require_user),
    ):
        """Set (or change) the student's time limit."""
        _check_csrf(request, csrf)
        try:
            session = load_session(request, user, session_id)
        except SessionError as exc:
            return redirect("/dashboard", request, str(exc))
        try:
            request.app.state.manager.set_time_limit(session, minutes)
        except SessionError as exc:
            return redirect(f"/sessions/{session_id}", request, str(exc))
        return redirect(f"/sessions/{session_id}", request, f"Time limit set to {minutes} minutes.")

    @app.get("/results", response_class=HTMLResponse)
    def results(request: Request, session: int = 0, user=Depends(require_user)):
        """Final submissions only — the results-only policy, made visible."""
        store = request.app.state.store
        role = user["role"]
        rows = (
            store.results_for_student(user["username"])
            if role != "instructor"
            else [r for s in store.list_sessions(limit=500) for r in [store.latest_report(s.id or 0)] if r]
        )
        return render(
            request,
            "results.html",
            {
                "results": rows,
                "highlight": session,
                "scenarios": {s.id: s for s in request.app.state.repo.list()},
            },
        )

    @app.post("/sessions/{session_id}/reset")
    def session_reset(request: Request, session_id: int, csrf: str = Form(""), user=Depends(require_user)):
        _check_csrf(request, csrf)
        if not settings.portal.allow_self_reset and user["role"] != "instructor":
            return redirect(f"/sessions/{session_id}", request, "Resetting is disabled; ask your instructor.")
        manager = request.app.state.manager
        try:
            session = load_session(request, user, session_id)
        except SessionError as exc:
            return redirect("/dashboard", request, str(exc))
        try:
            session = manager.reset(session)
        except SessionError as exc:
            return redirect(f"/sessions/{session_id}", request, str(exc))
        if session.state == SessionState.ERROR:
            return redirect(f"/sessions/{session_id}", request, session.error)
        return redirect(f"/sessions/{session_id}", request, "Reset: you have a clean machine again.")

    @app.post("/sessions/{session_id}/hint")
    def session_hint(request: Request, session_id: int, csrf: str = Form(""), user=Depends(require_user)):
        _check_csrf(request, csrf)
        manager = request.app.state.manager
        try:
            session = load_session(request, user, session_id)
        except SessionError as exc:
            return redirect("/dashboard", request, str(exc))
        scenario = request.app.state.repo.get(session.scenario_id)
        if settings.portal.hints_require_attempt and session.checks_run == 0:
            return redirect(
                f"/sessions/{session_id}",
                request,
                "Try the ticket once and run a check first; hints unlock after your first attempt.",
            )
        if session.hint_level >= len(scenario.hints):
            return redirect(f"/sessions/{session_id}", request, "No more hints for this scenario.")
        manager.reveal_hint(session, scenario)
        return redirect(f"/sessions/{session_id}", request, "Hint revealed.")

    @app.post("/sessions/{session_id}/extend")
    def session_extend(
        request: Request, session_id: int, minutes: int = Form(15), csrf: str = Form(""),
        user=Depends(require_user),
    ):
        _check_csrf(request, csrf)
        manager = request.app.state.manager
        try:
            session = load_session(request, user, session_id)
        except SessionError as exc:
            return redirect("/dashboard", request, str(exc))
        manager.extend(session, max(1, min(minutes, 240)))
        return redirect(f"/sessions/{session_id}", request, f"Extended by {minutes} minutes.")

    @app.post("/sessions/{session_id}/end")
    def session_end(request: Request, session_id: int, csrf: str = Form(""), user=Depends(require_user)):
        _check_csrf(request, csrf)
        manager = request.app.state.manager
        try:
            session = load_session(request, user, session_id)
        except SessionError as exc:
            return redirect("/dashboard", request, str(exc))
        manager.end(session)
        return redirect("/dashboard", request, "Session ended and the machine was destroyed.")

    # --------------------------------------------------------------- lessons --
    @app.get("/lessons", response_class=HTMLResponse)
    def lessons_index(request: Request, platform: str = "", user=Depends(require_user)):
        """The walkthrough library.

        Available to students *and* instructors, and reachable from the dashboard and
        from any session: the moment a student wants to know how chmod works is the
        moment they are staring at a broken machine, not before.
        """
        repository = request.app.state.lessons
        grouped = repository.by_platform()
        return render(
            request,
            "lessons.html",
            {
                "groups": [
                    {
                        "platform": key,
                        "lessons": lesson_index(repository, key),
                    }
                    for key in sorted(grouped)
                ],
                "selected": platform,
                "problems": repository.validate(),
            },
        )

    @app.get("/lessons/{lesson_id}", response_class=HTMLResponse)
    def lesson_page(request: Request, lesson_id: str, user=Depends(require_user)):
        repository = request.app.state.lessons
        try:
            lesson = repository.get(lesson_id)
        except LessonError as exc:
            return redirect("/lessons", request, str(exc))
        # Which scenarios this lesson is the walkthrough for — the other direction of
        # the link, so a student can go straight from learning to doing.
        related = [
            scenario
            for scenario in request.app.state.repo.list()
            if lesson.id in scenario.lessons
        ]
        return render(
            request,
            "lesson.html",
            {
                "lesson": lesson,
                "prerequisites": repository.for_scenario(lesson.prerequisites),
                "related": related,
                "shell_block": lesson.all_shell(),
            },
        )

    # ------------------------------------------------------------ instructor --
    @app.get("/instructor", response_class=HTMLResponse)
    def instructor(request: Request, user=Depends(require_instructor)):
        store = request.app.state.store
        manager = request.app.state.manager
        sessions = store.list_sessions(limit=200)
        rows = []
        for session in sessions:
            report = store.latest_report(session.id)
            try:
                scenario = request.app.state.repo.get(session.scenario_id)
            except ScenarioError:
                scenario = None
            rows.append(
                {
                    "session": session,
                    "report": report,
                    "remaining": session.seconds_remaining(),
                    "console": bool(_session_link(request, session)),
                    # The same connection detail the student is shown, so an instructor
                    # reading this list can reach a machine without opening the session
                    # first - which is the whole reason the list is here.
                    "address": _machine_address(settings, scenario, session) if scenario else {},
                }
            )
        # Both of these shell out to Incus, and this page has to render without it:
        # a host whose hypervisor is not prepared yet, or one whose machines live on
        # a cluster, is a normal place for an instructor to open it. The template
        # read was the unguarded half — ungarded it answered 500 and said nothing —
        # and the pool's message was stored on the app, so one failure put a
        # permanent "the pool is broken" banner on every later page.
        infra_errors: list[str] = []

        def read(label: str, call):
            try:
                return call()
            except Exception as exc:  # noqa: BLE001 - the instructor page must still render
                infra_errors.append(f"could not read the {label}: {exc}")
                return []

        # A console key the gateway refuses is an outage for every student in the
        # class and is invisible from both ends: the portal signs correctly, the
        # gateway says "Permission denied" to a link nobody kept. Report it where an
        # instructor is already looking when the first student says the console is
        # blank (the verdict is cached, so this is not a probe per render).
        if settings.guac.secret_key:
            state_name, detail = _console_gateway_verdict(request)
            if state_name == "refused":
                infra_errors.append(detail)

        return render(
            request,
            "instructor.html",
            {
                "rows": rows,
                "pool": read("warm pool", manager.pool_status),
                "templates_": read("templates", manager.template_status),
                "scenarios": request.app.state.repo.list(),
                "leaderboard": store.leaderboard(),
                "events": store.recent_events(limit=40),
                "states": SessionState,
                "infra_errors": infra_errors,
            },
        )

    @app.post("/instructor/prewarm")
    def instructor_prewarm(
        request: Request, scenario_id: str = Form(...), count: int = Form(5),
        workload: str = Form(""), csrf: str = Form(""), user=Depends(require_instructor),
    ):
        _check_csrf(request, csrf)
        created = request.app.state.manager.prewarm(
            scenario_id, max(0, min(count, 200)), workload=workload
        )
        label = f"{scenario_id}@{workload}" if workload else scenario_id
        return redirect("/instructor", request, f"Started {created} VM(s) for {label}.")

    @app.post("/instructor/template")
    def instructor_template(
        request: Request, scenario_id: str = Form(...), force: bool = Form(False),
        workload: str = Form(""), csrf: str = Form(""), user=Depends(require_instructor),
    ):
        _check_csrf(request, csrf)
        results = request.app.state.manager.build_templates(
            [scenario_id], force=force, workloads=[workload] if workload else None
        )
        key = f"{scenario_id}@{workload}" if workload else scenario_id
        return redirect("/instructor", request, f"{key}: {results.get(key, '?')}")

    @app.get("/instructor/results.csv")
    def instructor_csv(request: Request, user=Depends(require_instructor)):
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(["student", "scenario_id", "attempts", "best_score", "resolved"])
        for row in request.app.state.store.leaderboard():
            writer.writerow(
                [row["student"], row["scenario_id"], row["attempts"], row["best"], "yes" if row["solved"] else "no"]
            )
        buffer.seek(0)
        return StreamingResponse(
            iter([buffer.read()]),
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=ontrak-results.csv"},
        )

    # ---------------------------------------------------------------- admin --
    # The education-administration surface: users, the scenario and platform
    # catalogue, tickets, sessions, the schedule, results and the audit trail. Kept
    # in its own module because it is a different job from running a class.
    register_admin_routes(
        app,
        AdminContext(
            settings=settings,
            store=app.state.store,
            repo=app.state.repo,
            catalog=catalog,
            lessons=app.state.lessons,
            manager=app.state.manager,
            render=render,
            redirect=redirect,
            require_instructor=require_instructor,
            check_csrf=_check_csrf,
            csrf_token=_csrf_token,
            session_link=_session_link,
            workload_groups=_workload_groups,
            catalog_entry=catalog_entry,
            lesson_index=lesson_index,
        ),
    )

    @app.get("/instructor/sessions/{session_id}/console")
    def instructor_console(request: Request, session_id: int, user=Depends(require_instructor)):
        session = request.app.state.store.get_session(session_id)
        if session is None or not session.host_ip:
            return redirect("/instructor", request, "That session has no console.")
        url = _session_link(request, session)
        if not url:
            return redirect("/instructor", request, "Guacamole is not configured (guac.secret_key).")
        # Through the bootstrap, not straight at Guacamole: a tab opened here has the
        # same stale-token problem a student's frame does, and the bootstrap is the
        # one place that clears it. See `session_console`.
        return RedirectResponse(f"/sessions/{session_id}/console")

    # Seed the unattended bootstrap instructor last, once the store the app serves
    # from is settled.
    _seed_bootstrap_admin(app.state.store, settings)

    return app


# Module-level app so `uvicorn ontrak.portal.app:app` works without the CLI.
app = create_app()
