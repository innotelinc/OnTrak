"""Ontrak Sync — the API the dashboard talks to.

Design notes worth keeping, because each one is a decision rather than plumbing:

**Every route that can change something is authenticated, and most of them are
also authorised.** The API used to have exactly one credential — a static bearer
token — so "is this request allowed" and "is this request authenticated" were the
same question. They are not any more. A person signs in and gets a session; a
machine presents the deployment token; and on top of both sits a capability
check (`sync:apply`, `users:manage`) derived from the role. The Network is read by
more people than it is patched by, and the gap between those two groups is now
enforceable rather than documented.

`/api/health` and `/api/meta` stay open, because a container healthcheck has no
credentials to present and the login page has to know whether to draw an SSO
button.

**`auto` is a policy value, never a request parameter.** No route takes "just apply
this now regardless of mode". An operator who wants unattended updates sets the
mode in the settings form, where it is visible and persists; a request that could
bypass the policy would make the policy decorative.

**Reads never block on the Network.** A scan can take minutes across twenty-seven
containers, so scans and applies are POSTs that run synchronously but are guarded
by one lock — the reply is the run summary, and the dashboard renders it. A
background queue was the alternative and it buys progress bars at the cost of
"did my click work?" being unanswerable.
"""

from __future__ import annotations

import hmac
import logging
import threading
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field

from . import __version__, db, identity, oidc, reconcile
from .applier import apply_findings, approve_and_apply
from .config import Settings
from .policy import Cron, CronError, Policy, describe, next_runs
from .scan import host_admin_summary, scan_network
from .scheduler import Scheduler, load_policy, save_policy

log = logging.getLogger("ontrak.api")

# One lock for scans and applies, process-wide. Two Network walks at once would
# double every finding and put two apt transactions on the same host.
RUN_LOCK = threading.Lock()

# The service principal, for the deployment token. It is not a person and has no
# row in `users`: a token cannot be signed out of, cannot be given a role, and
# must not appear in the user list. Naming it here is what keeps those three
# statements true instead of aspirational.
SERVICE_ACTOR = "service:api-token"


@dataclass
class Actor:
    """Who is making this request, and what they may do."""

    name: str
    role: str
    capabilities: tuple[str, ...]
    via: str = "session"          # "session" | "cookie" | "token"
    user_id: int | None = None
    display_name: str = ""

    @property
    def authenticated(self) -> bool:
        return True

    def may(self, capability: str) -> bool:
        return capability in self.capabilities


class ApproveRequest(BaseModel):
    ids: list[int] = Field(default_factory=list)
    all_pending: bool = False
    security_only: bool = False
    # Record the decision AND install it in one call. The UI's Approve buttons set
    # this: a person clicking "Approve" means "do the update", and leaving the
    # install to a second click is how an approval sits recorded and unapplied.
    # Default False so the bare API still only records the decision.
    apply: bool = False


class ScanRequest(BaseModel):
    hosts: list[str] = Field(default_factory=list)


class ApplyRequest(BaseModel):
    ids: list[int] = Field(default_factory=list)
    all_approved: bool = True


class PolicyRequest(BaseModel):
    mode: str | None = None
    schedule: str | None = None
    enabled: bool | None = None
    timezone: str | None = None
    scopes: list[str] | None = None
    security_only: bool | None = None
    window_start_hour: int | None = None
    window_end_hour: int | None = None
    max_concurrent: int | None = None
    host_ids: list[int] | None = None
    # A change freeze: an inclusive ISO date range during which nothing is applied.
    # Empty strings clear it; `None` (an omitted field) leaves it alone.
    freeze_from: str | None = None
    freeze_to: str | None = None
    # A separate flag so "clear the window" is expressible. Without it, an omitted
    # field means "leave alone" and there is no way to remove a window once set.
    clear_window: bool = False


class LoginRequest(BaseModel):
    username: str = ""
    password: str = ""


class PasswordRequest(BaseModel):
    current_password: str = ""
    new_password: str = ""


class UserRequest(BaseModel):
    username: str = ""
    password: str | None = None
    email: str = ""
    display_name: str = ""
    role: str = "STUDENT"
    active: bool = True


class UserUpdateRequest(BaseModel):
    email: str | None = None
    display_name: str | None = None
    role: str | None = None
    active: bool | None = None
    password: str | None = None


def _policy_payload(policy: Policy) -> dict:
    """The policy plus the derived timer description the form displays."""
    data = policy.as_dict()
    data["next_runs"] = []
    data["description"] = describe(policy.schedule)
    try:
        data["next_runs"] = next_runs(Cron.parse(policy.schedule), count=5)
    except CronError as exc:
        data["description"] = f"invalid: {exc}"
    return data


def _client_address(request: Request) -> str:
    """The caller's address, preferring the edge's forward header.

    Behind the NPM edge every request arrives from the proxy, so `request.client`
    would be the same address for everybody and the per-address login throttle
    would protect nothing. The left-most entry of `X-Forwarded-For` is the
    original caller; it is spoofable, which is why it is used for *throttling*
    and never for authorisation.
    """
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()[:64]
    return (request.client.host if request.client else "")[:64]


def _cookie_secure(settings: Settings) -> bool:
    """A cookie may only be marked Secure on a deployment that terminates TLS.

    Marking it Secure on a plain-HTTP LAN deployment makes the browser drop it,
    which is a sign-in that reports success and then does nothing — worse than a
    cookie that is honest about being plain.
    """
    return settings.public_url.lower().startswith("https://")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    conn = db.connect(settings.db_path)
    db.init(conn)
    state: dict = {"scheduler": None}

    if not settings.api_token:
        # Refusing to start is the right failure. A monitoring tool that can install
        # packages on every machine in the Network must not come up answering
        # unauthenticated requests "just until the token is set".
        raise RuntimeError(
            "ONTRAK_API_TOKEN is not set. There is no default: this service can "
            "install packages across the Network, so it will not start without one."
        )

    # ── first run ────────────────────────────────────────────────────────────
    # An empty database needs somebody who can sign in, or the dashboard is a login
    # page nobody can pass. `ensure_bootstrap_admin` returns a generated password
    # exactly once; it is logged and never stored in plaintext anywhere.
    _, generated = identity.ensure_bootstrap_admin(
        conn, username=settings.admin_user, password=settings.admin_password,
        email=settings.admin_email,
    )
    if generated:
        log.warning(
            "created the first administrator %r with a generated password: %s  "
            "— sign in at the dashboard and change it now (set ONTRAK_ADMIN_PASSWORD "
            "to choose it instead)", settings.admin_user, generated,
        )
    identity.purge_expired_sessions(conn)

    oidc_client = oidc.OidcClient(
        issuer=settings.oidc_issuer,
        client_id=settings.oidc_client_id,
        client_secret=settings.oidc_client_secret,
        scopes=settings.oidc_scopes,
        provider_name=settings.oidc_provider_name,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if settings.scheduler_enabled:
            scheduler = Scheduler(conn, settings, lock=RUN_LOCK)
            scheduler.start()
            state["scheduler"] = scheduler
        yield
        if state["scheduler"] is not None:
            state["scheduler"].stop()

    app = FastAPI(title="Ontrak Sync", version=__version__, lifespan=lifespan)
    app.state.conn = conn

    # The dashboard is a separate origin in development and same-origin behind the
    # proxy in production, so CORS is permissive on the LAN but every route that
    # matters still requires a credential. `allow_credentials` stays false: cookies
    # are for the same-origin deployment only, and allowing them cross-origin
    # would be the one combination that needs CSRF protection this service does
    # not implement.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ── authentication ───────────────────────────────────────────────────────
    def _from_token(request: Request) -> str:
        header = request.headers.get("authorization", "")
        token = header[7:].strip() if header.lower().startswith("bearer ") else ""
        return token or request.headers.get("x-api-token", "").strip()

    def _actor_for(user: identity.User, via: str) -> Actor:
        return Actor(name=user.username, role=user.role,
                     capabilities=identity.role_capabilities(user.role),
                     via=via, user_id=user.id, display_name=user.display_name)

    def _authenticate(request: Request, *, capability: str | None = None) -> Actor:
        """Resolve the caller, then check the capability. Raises 401 or 403.

        Three credentials are accepted, in this order, and the order is the point:

          1. **the deployment token**, as a bearer value. This is the
             machine-to-machine credential — `make scan`, a monitoring bridge, a
             cron job — and it authenticates a *service principal*, not a person.
          2. **the session cookie**, for the same-origin deployment behind the
             Cerulean edge. Set `HttpOnly`, so a script on the page cannot read it.
          3. **a session token as a bearer value**, which is what the dashboard
             uses when it talks to the API on another origin. Same lookup, same
             revocation.

        The two failure codes are deliberately different. 401 means "present a
        credential" and sends the dashboard to its login page; 403 means "you are
        signed in and this is not yours" and must NOT, because redirecting a
        signed-in user to login is an infinite loop that looks like a broken
        session.
        """
        supplied = _from_token(request)
        cookie = request.cookies.get(identity.SESSION_COOKIE, "")

        if supplied and hmac.compare_digest(supplied, settings.api_token):
            return _authorize(
                Actor(name=SERVICE_ACTOR, role="SERVICE",
                      capabilities=identity.CAPABILITIES, via="token"),
                capability)

        if cookie:
            resolution = identity.resolve_session(conn, cookie)
            if resolution:
                actor = _actor_for(resolution["user"], "cookie")
                _check_csrf(request, actor)
                return _authorize(actor, capability)

        if supplied:
            resolution = identity.resolve_session(conn, supplied)
            if resolution:
                return _authorize(_actor_for(resolution["user"], "session"), capability)

        raise HTTPException(status_code=401, detail="sign-in required")

    def _check_csrf(request: Request, actor: Actor) -> None:
        """Cookie-authenticated writes must prove they came from this application.

        `SameSite=Lax` already stops a browser attaching the cookie to a
        cross-site form POST, and CORS with `allow_credentials=False` stops a
        scripted one. This header is the third lock on the same door, and it costs
        nothing: a cross-origin page cannot set a custom header without a
        preflight this service refuses.
        """
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return
        if actor.via != "cookie":
            return
        if request.headers.get("x-ontrak-csrf", "").strip() != "1":
            raise HTTPException(status_code=403, detail="missing CSRF header")

    def _authorize(actor: Actor, capability: str | None) -> Actor:
        if capability and not actor.may(capability):
            # The refusal is audited: "who tried to apply and was told no" is
            # exactly the question asked after an unauthorised change, and it is
            # unanswerable if only the successes are recorded.
            identity.audit(conn, "auth.denied",
                           f"{actor.name} ({actor.role}) lacks {capability}",
                           level="warning", actor=actor.name)
            conn.commit()
            raise HTTPException(
                status_code=403,
                detail=f"this account may not {capability.split(':', 1)[-1]} — "
                       f"it is {actor.role}",
            )
        return actor

    def requires(capability: str | None = None):
        """A FastAPI dependency that resolves the actor and checks a capability."""

        def dependency(request: Request) -> Actor:
            return _authenticate(request, capability=capability)

        return Depends(dependency)

    # ── session cookies ──────────────────────────────────────────────────────
    def _set_session_cookie(response: Response, token: str) -> None:
        response.set_cookie(
            identity.SESSION_COOKIE, token,
            max_age=identity.SESSION_TTL_SECONDS,
            httponly=True, samesite="lax", secure=_cookie_secure(settings), path="/",
        )

    def _clear_session_cookie(response: Response) -> None:
        response.delete_cookie(identity.SESSION_COOKIE, path="/")

    def _session_response(user: identity.User, token: str, expires_at: str) -> JSONResponse:
        """The one shape a successful sign-in returns.

        The token is in the body as well as the cookie on purpose: the dashboard
        talks to the API cross-origin in development and from a service worker
        context nowhere, and the cookie path only exists for the same-origin
        deployment behind the edge. Both are the caller's own credential.
        """
        response = JSONResponse({
            "user": user.public(),
            "token": token,
            "expires_at": expires_at,
        })
        _set_session_cookie(response, token)
        return response

    # ── open ─────────────────────────────────────────────────────────────────
    @app.get("/api/health")
    def health():
        """Liveness plus the one number that matters: is the timer running?"""
        scheduler = state.get("scheduler")
        return {
            "status": "ok",
            "scheduler": bool(scheduler and scheduler.is_alive()),
            "scheduler_enabled": settings.scheduler_enabled,
            "hosts_configured": len(settings.hosts),
            "last_fired_at": getattr(scheduler, "last_fired_at", None),
        }

    @app.get("/api/meta")
    def meta():
        """What the login page and the Network header need before auth.

        `users_exist` is here rather than behind the login so the page can say
        "this deployment has no accounts yet" instead of showing a form that
        cannot succeed. It reveals only whether the service has ever been set up.
        """
        return {
            "service": "ontrak-sync",
            "version": __version__,
            "hosts": [asdict(h) for h in settings.hosts],
            "scheduler_enabled": settings.scheduler_enabled,
            "users_exist": identity.count_users(conn) > 0,
            "sso": {
                "enabled": oidc_client.configured,
                "provider": settings.oidc_provider_name,
                "start_url": "/api/auth/sso/start",
            },
            "roles": [
                {"name": role, "label": identity.ROLE_LABELS.get(role, role),
                 "products": list(identity.products_for(role))}
                for role in identity.ROLES
            ],
        }

    # ── sign in, sign out, and who am I ──────────────────────────────────────
    @app.post("/api/auth/login")
    def login(body: LoginRequest, request: Request):
        outcome = identity.authenticate(
            conn, username=body.username, password=body.password,
            address=_client_address(request),
            user_agent=request.headers.get("user-agent", ""),
        )
        if not outcome.ok or outcome.user is None or outcome.token is None:
            headers = {"Retry-After": str(outcome.retry_after)} if outcome.retry_after else None
            return JSONResponse(status_code=401, content={"detail": outcome.reason},
                                headers=headers)
        return _session_response(outcome.user, outcome.token, outcome.expires_at or "")

    @app.post("/api/auth/logout")
    def logout(request: Request, response: Response):
        """Sign out. Idempotent, and never a 401.

        A sign-out that fails because the session had already expired leaves the
        dashboard holding a credential it cannot get rid of, so this always
        succeeds and always clears the cookie.
        """
        supplied = _from_token(request)
        cookie = request.cookies.get(identity.SESSION_COOKIE, "")
        for token in {supplied, cookie}:
            if token and token != settings.api_token:
                resolution = identity.resolve_session(conn, token)
                if resolution:
                    identity.audit(conn, "auth.logout",
                                   f"{resolution['user'].username} signed out",
                                   actor=resolution["user"].username)
                identity.revoke_session(conn, token)
        _clear_session_cookie(response)
        return {"signed_out": True}

    @app.get("/api/auth/me")
    def me(actor: Actor = requires("portal:view")):
        """The signed-in identity, its role and what that role unlocks.

        This is what the dashboard's shell reads on load: the nav it may draw, the
        buttons it may show, and the products this person belongs in.
        """
        user = identity.get_user(conn, user_id=actor.user_id) if actor.user_id else None
        if user is None:
            return {
                "service": True,
                "username": actor.name,
                "role": actor.role,
                "capabilities": list(actor.capabilities),
                "products": [],
                "via": actor.via,
            }
        return {**user.public(), "via": actor.via}

    @app.post("/api/auth/password")
    def change_password(body: PasswordRequest, actor: Actor = requires("portal:view")):
        """Change your own password. Requires the current one, always."""
        if actor.user_id is None:
            raise HTTPException(status_code=403,
                                detail="the deployment token is not a person's account")
        user = identity.get_user(conn, user_id=actor.user_id)
        if user is None:
            raise HTTPException(status_code=401, detail="sign-in required")
        if not identity.verify_password(body.current_password, user.password_hash):
            identity.audit(conn, "auth.password.denied",
                           f"{user.username} gave a wrong current password",
                           level="warning", actor=user.username)
            raise HTTPException(status_code=403, detail="the current password is not correct")
        problems = identity.password_problems(body.new_password, username=user.username,
                                              email=user.email)
        if problems:
            raise HTTPException(status_code=422, detail={"problems": problems})
        if identity.verify_password(body.new_password, user.password_hash):
            raise HTTPException(status_code=422,
                                detail={"problems": ["must be different from the current one"]})
        identity.set_password(conn, user.id, body.new_password)
        identity.audit(conn, "auth.password.change",
                       f"{user.username} changed their password", actor=user.username)
        return {"changed": True, "sessions_revoked": True}

    # ── Cerulean SSO ─────────────────────────────────────────────────────────
    @app.get("/api/auth/sso/start")
    def sso_start(request: Request, next: str = Query(default="")):
        """Send the browser to Cerulean. Nothing is trusted until the callback."""
        if not oidc_client.configured or not settings.redirect_uri:
            raise HTTPException(
                status_code=503,
                detail="single sign-on is not configured for this deployment",
            )
        pending = oidc.AuthorizationState.new(return_to=oidc.safe_return_to(
            next or settings.post_login_redirect, fallback=settings.post_login_redirect or "/"))
        response = RedirectResponse(
            oidc_client.authorization_url(pending, settings.redirect_uri), status_code=303)
        response.set_cookie(
            "ontrak_sso_state", oidc.sign_state(pending, settings.state_secret),
            max_age=oidc.STATE_TTL_SECONDS, httponly=True, samesite="lax",
            secure=_cookie_secure(settings), path="/",
        )
        return response

    @app.get("/api/auth/sso/callback")
    def sso_callback(request: Request, code: str = Query(default=""),
                     state: str = Query(default=""), error: str = Query(default="")):
        """The provider sent the browser back. Verify, then sign in or refuse.

        Every failure here is a redirect to the dashboard with `?sso_error=<why>`
        rather than a JSON blob: the thing that arrives at this URL is always a
        browser, and a browser shown raw JSON has no way back to the login page.
        """
        target = settings.post_login_redirect or "/"

        def refuse(reason: str) -> RedirectResponse:
            identity.audit(conn, "auth.sso.denied", reason, level="warning")
            separator = "&" if "?" in target else "?"
            return RedirectResponse(f"{target}{separator}sso_error={reason}", status_code=303)

        if error:
            return refuse(f"{settings.oidc_provider_name} refused the sign-in ({error})")
        pending = oidc.read_state(request.cookies.get("ontrak_sso_state", ""),
                                  settings.state_secret)
        if pending is None:
            return refuse("the sign-in expired or was replayed — start again")
        if not code:
            return refuse("the provider returned no authorization code")
        if state and state != pending.state:
            return refuse("the sign-in state did not match")

        try:
            tokens = oidc_client.exchange_code(code, settings.redirect_uri, pending.verifier)
            claims = oidc_client.verify_id_token(
                str(tokens.get("id_token") or ""), nonce=pending.nonce,
                redirect_uri=settings.redirect_uri)
            # Authentik puts `groups` on the userinfo endpoint for some flows; the
            # ID token is authoritative and this only fills a gap, never overrides.
            if not claims.get("groups") and tokens.get("access_token"):
                extra = oidc_client.userinfo(str(tokens["access_token"]))
                if extra.get("groups"):
                    claims = {**claims, "groups": extra["groups"]}
        except oidc.OidcError as exc:
            return refuse(str(exc))

        incoming = identity.OidcClaims.from_payload(claims)
        domains = settings.oidc_allowed_domains
        if domains and incoming.email.split("@")[-1].lower() not in domains:
            return refuse("this account's domain is not allowed to sign in here")

        user, reason, _provisioned = identity.resolve_oidc_user(
            conn, incoming, settings.oidc_role_map, settings.oidc_default_role)
        if user is None:
            return refuse(reason or "this account is not allowed in")

        token, _expires = identity.create_session(
            conn, user.id, user_agent=request.headers.get("user-agent", ""),
            address=_client_address(request))
        conn.execute("UPDATE users SET last_login_at=?, updated_at=? WHERE id=?",
                     (db.utcnow(), db.utcnow(), user.id))
        conn.commit()
        identity.audit(conn, "auth.sso.sign_in",
                       f"{user.username} signed in through {settings.oidc_provider_name} "
                       f"as {user.role}", actor=user.username)

        response = RedirectResponse(oidc.safe_return_to(pending.return_to,
                                                        fallback=settings.post_login_redirect or "/"),
                                    status_code=303)
        _set_session_cookie(response, token)
        response.delete_cookie("ontrak_sso_state", path="/")
        return response

    # ── people ───────────────────────────────────────────────────────────────
    @app.get("/api/users", dependencies=[requires("users:manage")])
    def list_users():
        return {"users": [u.public() for u in identity.list_users(conn)]}

    @app.post("/api/users")
    def create_user(body: UserRequest, actor: Actor = requires("users:manage")):
        if not body.username.strip():
            raise HTTPException(status_code=422, detail={"problems": ["a username is required"]})
        if identity.get_user(conn, username=body.username):
            raise HTTPException(status_code=409,
                                detail={"problems": ["that username is taken"]})
        role = identity.normalize_role(body.role)
        if body.password:
            problems = identity.password_problems(body.password, username=body.username,
                                                  email=body.email)
            if problems:
                raise HTTPException(status_code=422, detail={"problems": problems})
        user = identity.create_user(
            conn, username=body.username, password=body.password or None, role=role,
            email=body.email, display_name=body.display_name or body.username,
            active=body.active,
        )
        identity.audit(conn, "users.create",
                       f"created {user.username} as {user.role}"
                       + (" (SSO only)" if not body.password else ""),
                       actor=actor.name)
        return user.public()

    @app.put("/api/users/{user_id}")
    def update_user(user_id: int, body: UserUpdateRequest, actor: Actor = requires("users:manage")):
        user = identity.get_user(conn, user_id=user_id)
        if user is None:
            raise HTTPException(status_code=404, detail="no such user")

        # The last administrator cannot be demoted or switched off from here. A
        # deployment with no administrator left has to be repaired by hand, and
        # "I locked myself out" is not a security property worth having.
        demoting = (body.role is not None and identity.normalize_role(body.role) != "ADMIN")
        deactivating = body.active is False
        if user.role == "ADMIN" and (demoting or deactivating) and \
                identity.count_active_admins(conn) <= 1:
            raise HTTPException(
                status_code=409,
                detail={"problems": ["this is the last active administrator — "
                                     "promote another one first"]})

        if body.password is not None and body.password != "":
            problems = identity.password_problems(body.password, username=user.username,
                                                  email=body.email or user.email)
            if problems:
                raise HTTPException(status_code=422, detail={"problems": problems})
            identity.set_password(conn, user.id, body.password)
        elif body.password == "":
            identity.clear_password(conn, user.id)

        updated = identity.update_user(
            conn, user.id, email=body.email, display_name=body.display_name,
            role=body.role, active=body.active,
        )
        if body.role is not None and identity.normalize_role(body.role) != user.role:
            identity.audit(conn, "users.role.change",
                           f"{user.username}: {user.role} → {identity.normalize_role(body.role)}",
                           actor=actor.name)
        else:
            identity.audit(conn, "users.update", f"updated {user.username}", actor=actor.name)
        return updated.public() if updated else None

    @app.delete("/api/users/{user_id}")
    def delete_user(user_id: int, actor: Actor = requires("users:manage")):
        user = identity.get_user(conn, user_id=user_id)
        if user is None:
            raise HTTPException(status_code=404, detail="no such user")
        if actor.user_id == user.id:
            raise HTTPException(status_code=409,
                                detail="delete a person's account with their own session? "
                                       "sign in as another administrator")
        if user.role == "ADMIN" and identity.count_active_admins(conn) <= 1:
            raise HTTPException(status_code=409,
                                detail="this is the last active administrator")
        identity.delete_user(conn, user.id)
        identity.audit(conn, "users.delete", f"deleted {user.username}", level="warning",
                       actor=actor.name)
        return {"deleted": True}

    @app.get("/api/sessions")
    def list_sessions(actor: Actor = requires("portal:view")):
        """Your own sessions. An administrator sees every session."""
        if actor.may("users:manage"):
            return {"sessions": identity.list_sessions(conn),
                    "scope": "all"}
        if actor.user_id is None:
            return {"sessions": [], "scope": "none"}
        own = identity.list_sessions(conn, actor.user_id)
        # The token is not in this response and cannot be derived from it; the
        # fields are what a person needs to recognise a device they do not
        # recognise.
        return {"sessions": own, "scope": "own"}

    @app.delete("/api/sessions/{session_id}")
    def revoke_session(session_id: int, request: Request, actor: Actor = requires("portal:view")):
        rows = identity.list_sessions(conn)
        target = next((row for row in rows if int(row["id"]) == int(session_id)), None)
        if target is None:
            raise HTTPException(status_code=404, detail="no such session")
        if actor.user_id != target["user_id"] and not actor.may("users:manage"):
            raise HTTPException(status_code=403, detail="that session is not yours")
        identity.revoke_session_by_id(conn, session_id)
        identity.audit(conn, "auth.session.revoke",
                       f"revoked a session for {target['username']}", actor=actor.name)
        return {"revoked": True}

    # ── Network ───────────────────────────────────────────────────────────────
    @app.get("/api/summary", dependencies=[requires("sync:view")])
    def summary():
        return host_admin_summary(conn, stale_failure_seconds=settings.stale_failure_seconds)

    @app.get("/api/hosts", dependencies=[requires("sync:view")])
    def hosts():
        """The Network's hosts, each carrying what the registry would not judge.

        The refusal counts ride along rather than sitting behind a second call: the
        hosts page is where an operator asks why a scan read `partial`, and a metric
        that needs its own request is one the page will not make. They come with the
        stored window as a `series` of per-run counts, so the page can draw the history
        instead of only the newest scan. `None` means nothing was refused on that host's
        newest scan — not that nobody looked, which the scan's own row already says.
        """
        refusals = db.registry_refusal_summary(conn)
        return {"hosts": [
            {**row, "registry_refusals": refusals.get(row["name"])}
            for row in db.list_hosts(conn)
        ]}

    @app.get("/api/hosts/{name}", dependencies=[requires("sync:view")])
    def host_detail(name: str):
        row = conn.execute("SELECT * FROM hosts WHERE name=?", (name,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail=f"no such host: {name}")
        targets = db.list_targets(conn, host=name)
        return {
            "host": dict(row),
            "targets": [
                {
                    **target,
                    "findings": db.list_findings(conn, target_id=target["id"], limit=500),
                }
                for target in targets
            ],
        }

    @app.get("/api/targets", dependencies=[requires("sync:view")])
    def targets(host: str | None = None):
        return {"targets": db.list_targets(conn, host=host)}

    @app.get("/api/findings", dependencies=[requires("sync:view")])
    def findings(
        status: str | None = Query(default=None),
        manager: str | None = Query(default=None),
        host: str | None = Query(default=None),
        security_only: bool = Query(default=False),
        limit: int = Query(default=2000, le=10000),
    ):
        rows = db.list_findings(conn, status=status, manager=manager, host=host,
                                security_only=security_only, limit=limit)
        return {"findings": rows, "count": len(rows)}

    @app.get("/api/runs", dependencies=[requires("sync:view")])
    def runs(limit: int = Query(default=40, le=500)):
        return {"runs": db.list_runs(conn, limit=limit)}

    @app.get("/api/reconcile", dependencies=[requires("sync:view")])
    def reconcile_report():
        """What vanished on the last scan, and what is failing long enough to decide.

        Read-only, and safe to call on a dashboard refresh: the stale check is
        recomputed against the clock, while the vanished names come back from the
        report the last scan stored. The scan itself records a `reconcile` run when
        it finds anything, which is what the Runs page shows.
        """
        current = reconcile.current(conn, settings)
        return {**current, "stored": reconcile.stored(conn)}

    @app.get("/api/events", dependencies=[requires("sync:view")])
    def events(limit: int = Query(default=200, le=2000)):
        return {"events": db.list_events(conn, limit=limit)}

    # ── workflow ─────────────────────────────────────────────────────────────
    @app.post("/api/findings/approve")
    def approve(body: ApproveRequest, actor: Actor = requires("sync:approve")):
        """Mark findings approved, and — when asked — install them in the same call.

        Marking a finding approved is what detect-only mode waits for; on its own it
        changes no machine. `apply=True` is the button: one click records the
        decision and runs it, so an approval cannot sit recorded and unapplied
        because a second button was missed. It installs packages, so it needs
        `sync:apply` as well as `sync:approve`, and it is refused for an actor who
        holds only the latter.
        """
        ids = list(body.ids)
        if body.all_pending:
            pending = db.list_findings(conn, status="pending", security_only=body.security_only)
            ids = [row["id"] for row in pending]
        if body.apply and not actor.may("sync:apply"):
            raise HTTPException(status_code=403,
                                detail="approving and applying installs packages, which needs sync:apply")
        if not ids:
            return {"approved": 0}
        if not body.apply:
            changed = db.set_status(conn, ids, "approved")
            db.log(conn, f"{changed} finding(s) approved", actor=actor.name)
            identity.audit(conn, "findings.approve", f"approved {changed} finding(s)",
                           actor=actor.name)
            conn.commit()
            return {"approved": changed}
        # The install is the same path as `/api/apply`, under the same lock, so an
        # approval-triggered apply cannot run alongside a scan or another apply. The
        # intent is audited before the write, so a refused or failed apply still
        # leaves who asked for it on record.
        identity.audit(conn, "findings.approve", f"approved {len(ids)} finding(s) to apply",
                       actor=actor.name)
        conn.commit()
        if not RUN_LOCK.acquire(blocking=False):
            raise HTTPException(status_code=409, detail="a scan or apply is already running")
        try:
            changed, outcome = approve_and_apply(
                conn, settings, load_policy(conn, settings), finding_ids=ids,
                actor=actor.name, apply=True, trigger=f"approve:{actor.name}")
        finally:
            RUN_LOCK.release()
        return {"approved": changed, **(outcome or {})}

    @app.post("/api/findings/skip")
    def skip(body: ApproveRequest, actor: Actor = requires("sync:approve")):
        """Leave these alone for now. A later scan re-reports them."""
        ids = list(body.ids)
        if body.all_pending:
            ids = [row["id"] for row in db.list_findings(conn, status="pending",
                                                         security_only=body.security_only)]
        if not ids:
            return {"skipped": 0}
        changed = db.set_status(conn, ids, "skipped")
        db.log(conn, f"{changed} finding(s) skipped", actor=actor.name)
        identity.audit(conn, "findings.skip", f"skipped {changed} finding(s)", actor=actor.name)
        conn.commit()
        return {"skipped": changed}

    @app.post("/api/scan")
    def scan(body: ScanRequest, actor: Actor = requires("sync:scan")):
        policy = load_policy(conn, settings)
        if not RUN_LOCK.acquire(blocking=False):
            raise HTTPException(status_code=409, detail="a scan or apply is already running")
        try:
            identity.audit(conn, "scan.manual", f"scan triggered by {actor.name}",
                           actor=actor.name)
            conn.commit()
            return scan_network(conn, settings, policy, trigger=f"manual:{actor.name}",
                               host_names=body.hosts or None)
        finally:
            RUN_LOCK.release()

    @app.post("/api/apply")
    def apply(body: ApplyRequest, actor: Actor = requires("sync:apply")):
        """Apply approved findings.

        `all_approved` is the button in the UI; an explicit id list is for
        re-running a subset after a failure. Pending findings are NOT applied here
        even in `auto` mode — this is the manual path, and the manual path requires a
        decision to have been recorded.
        """
        if not RUN_LOCK.acquire(blocking=False):
            raise HTTPException(status_code=409, detail="a scan or apply is already running")
        try:
            policy = load_policy(conn, settings)
            ids = list(body.ids)
            if body.all_approved and not ids:
                ids = [row["id"] for row in db.list_findings(conn, status="approved")]
            if not ids:
                return {"applied": 0, "failed": 0, "manual": [], "summary": "nothing approved"}
            identity.audit(conn, "apply.manual",
                           f"{actor.name} applying {len(ids)} approved finding(s)",
                           level="warning", actor=actor.name)
            conn.commit()
            return apply_findings(conn, settings, policy, finding_ids=ids,
                                  trigger=f"manual:{actor.name}")
        finally:
            RUN_LOCK.release()

    # ── the timer ────────────────────────────────────────────────────────────
    @app.get("/api/settings", dependencies=[requires("sync:configure")])
    def get_settings():
        return _policy_payload(load_policy(conn, settings))

    @app.put("/api/settings")
    def put_settings(body: PolicyRequest, actor: Actor = requires("sync:configure")):
        current = load_policy(conn, settings)
        data = current.as_dict()
        for key in ("mode", "schedule", "enabled", "timezone", "scopes", "security_only",
                    "window_start_hour", "window_end_hour", "max_concurrent", "host_ids",
                    "freeze_from", "freeze_to"):
            value = getattr(body, key)
            if value is not None:
                data[key] = value
        if body.clear_window:
            data["window_start_hour"] = None
            data["window_end_hour"] = None
        candidate = Policy.from_dict(data)
        problems = save_policy(conn, candidate)
        if problems:
            # 422 with every complaint, so the form can show them all at once.
            raise HTTPException(status_code=422, detail={"problems": problems})
        identity.audit(conn, "settings.policy",
                       f"{actor.name} set mode={candidate.mode} schedule={candidate.schedule!r} "
                       f"enabled={candidate.enabled}", level="warning", actor=actor.name)
        return _policy_payload(candidate)

    @app.post("/api/settings/preview", dependencies=[requires("sync:configure")])
    def preview(body: PolicyRequest):
        """Check an expression without saving it — the form validates as you type."""
        expression = body.schedule or load_policy(conn, settings).schedule
        try:
            cron = Cron.parse(expression)
        except CronError as exc:
            return JSONResponse(status_code=200,
                                content={"valid": False, "problems": [f"schedule: {exc}"],
                                         "next_runs": [], "description": f"invalid: {exc}"})
        return {"valid": True, "problems": [], "description": describe(expression),
                "next_runs": next_runs(cron, count=5)}

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception):
        log.exception("unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(status_code=500, content={"detail": "internal error"})

    return app
