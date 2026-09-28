"""Ontrak Sync — the API the dashboard talks to.

Design notes worth keeping, because each one is a decision rather than plumbing:

**Not every route is authenticated, but every route that can change something is.**
`/api/health` and `/api/meta` are open so a container healthcheck and the login
page can work before a token exists. Everything that reads the estate or touches it
requires the bearer token, compared with `hmac.compare_digest` so the check does not
leak the token's length or prefix through timing.

**`auto` is a policy value, never a request parameter.** No route takes "just apply
this now regardless of mode". An operator who wants unattended updates sets the
mode in the settings form, where it is visible and persists; a request that could
bypass the policy would make the policy decorative.

**Reads never block on the estate.** A scan can take minutes across twenty-seven
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
from dataclasses import asdict

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import db
from .applier import apply_findings
from .config import Settings
from .policy import Cron, CronError, Policy, describe, next_runs
from .scan import host_admin_summary, scan_estate
from .scheduler import Scheduler, load_policy, save_policy

log = logging.getLogger("ontrak.api")

# One lock for scans and applies, process-wide. Two estate walks at once would
# double every finding and put two apt transactions on the same host.
RUN_LOCK = threading.Lock()


class ApproveRequest(BaseModel):
    ids: list[int] = Field(default_factory=list)
    all_pending: bool = False
    security_only: bool = False


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
    # A separate flag so "clear the window" is expressible. Without it, an omitted
    # field means "leave alone" and there is no way to remove a window once set.
    clear_window: bool = False


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


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    conn = db.connect(settings.db_path)
    db.init(conn)
    state: dict = {"scheduler": None}

    if not settings.api_token:
        # Refusing to start is the right failure. A monitoring tool that can install
        # packages on every machine in the estate must not come up answering
        # unauthenticated requests "just until the token is set".
        raise RuntimeError(
            "ONTRAK_API_TOKEN is not set. There is no default: this service can "
            "install packages across the estate, so it will not start without one."
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

    app = FastAPI(title="Ontrak Sync", version="1.0.0", lifespan=lifespan)
    app.state.conn = conn

    # The dashboard is a separate origin in development and same-origin behind the
    # proxy in production, so CORS is permissive on the LAN but the token is still
    # required for anything that matters.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    def require_token(request: Request) -> None:
        header = request.headers.get("authorization", "")
        token = header[7:].strip() if header.lower().startswith("bearer ") else ""
        token = token or request.headers.get("x-api-token", "").strip()
        if not token or not hmac.compare_digest(token, settings.api_token):
            raise HTTPException(status_code=401, detail="missing or invalid API token")

    auth = Depends(require_token)

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
        """What the login page and the estate header need before auth."""
        return {
            "service": "ontrak-sync",
            "version": "1.0.0",
            "hosts": [asdict(h) for h in settings.hosts],
            "scheduler_enabled": settings.scheduler_enabled,
        }

    # ── estate ───────────────────────────────────────────────────────────────
    @app.get("/api/summary", dependencies=[auth])
    def summary():
        return host_admin_summary(conn)

    @app.get("/api/hosts", dependencies=[auth])
    def hosts():
        return {"hosts": db.list_hosts(conn)}

    @app.get("/api/hosts/{name}", dependencies=[auth])
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

    @app.get("/api/targets", dependencies=[auth])
    def targets(host: str | None = None):
        return {"targets": db.list_targets(conn, host=host)}

    @app.get("/api/findings", dependencies=[auth])
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

    @app.get("/api/runs", dependencies=[auth])
    def runs(limit: int = Query(default=40, le=500)):
        return {"runs": db.list_runs(conn, limit=limit)}

    @app.get("/api/events", dependencies=[auth])
    def events(limit: int = Query(default=200, le=2000)):
        return {"events": db.list_events(conn, limit=limit)}

    # ── workflow ─────────────────────────────────────────────────────────────
    @app.post("/api/findings/approve", dependencies=[auth])
    def approve(body: ApproveRequest):
        """Mark findings approved. This is what detect-only mode waits for."""
        ids = list(body.ids)
        if body.all_pending:
            pending = db.list_findings(conn, status="pending", security_only=body.security_only)
            ids = [row["id"] for row in pending]
        if not ids:
            return {"approved": 0}
        changed = db.set_status(conn, ids, "approved")
        db.log(conn, f"{changed} finding(s) approved")
        conn.commit()
        return {"approved": changed}

    @app.post("/api/findings/skip", dependencies=[auth])
    def skip(body: ApproveRequest):
        """Leave these alone for now. A later scan re-reports them."""
        ids = list(body.ids)
        if body.all_pending:
            ids = [row["id"] for row in db.list_findings(conn, status="pending",
                                                         security_only=body.security_only)]
        if not ids:
            return {"skipped": 0}
        changed = db.set_status(conn, ids, "skipped")
        db.log(conn, f"{changed} finding(s) skipped")
        conn.commit()
        return {"skipped": changed}

    @app.post("/api/scan", dependencies=[auth])
    def scan(body: ScanRequest):
        policy = load_policy(conn, settings)
        if not RUN_LOCK.acquire(blocking=False):
            raise HTTPException(status_code=409, detail="a scan or apply is already running")
        try:
            return scan_estate(conn, settings, policy, trigger="manual",
                               host_names=body.hosts or None)
        finally:
            RUN_LOCK.release()

    @app.post("/api/apply", dependencies=[auth])
    def apply(body: ApplyRequest):
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
            return apply_findings(conn, settings, policy, finding_ids=ids, trigger="manual")
        finally:
            RUN_LOCK.release()

    # ── the timer ────────────────────────────────────────────────────────────
    @app.get("/api/settings", dependencies=[auth])
    def get_settings():
        return _policy_payload(load_policy(conn, settings))

    @app.put("/api/settings", dependencies=[auth])
    def put_settings(body: PolicyRequest):
        current = load_policy(conn, settings)
        data = current.as_dict()
        for key in ("mode", "schedule", "enabled", "timezone", "scopes", "security_only",
                    "window_start_hour", "window_end_hour", "max_concurrent", "host_ids"):
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
        return _policy_payload(candidate)

    @app.post("/api/settings/preview", dependencies=[auth])
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
