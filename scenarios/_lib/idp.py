#!/usr/bin/env python3
"""A simulated directory service for identity scenarios.

Real directory products (AD, Entra, FreeIPA, LDAP) are licensed, heavy and mostly
impossible to break safely on a shared lab host. This is the part that matters for
training: accounts with a status, group membership, live sessions, and an audit log
that records *who changed what, and why*.

It is deliberately boring:

* state is one JSON document — you can read the whole directory with `cat`/`jq`, which
  makes it teachable in a way a real LDAP tree is not;
* every mutation writes an audit entry, so "did the student record the change?" is a
  machine-checkable question rather than a matter of trust;
* the CLI works directly on the file (no daemon required, so grading never depends on
  a background process surviving), and `serve` exposes the same operations over HTTP
  so a student can point `curl` at it the way they would at a real service.

Deployed by the identity scenarios' ``setup.sh`` from the shared scenario library, and
run as ``python3 lib/idp.py --state <file> <command>``.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEFAULT_STATE = "/var/lib/ontrak-idp/directory.json"
ACTIVE, LOCKED, DISABLED = "active", "locked", "disabled"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Directory:
    """The directory document, with the operations a service desk performs."""

    def __init__(self, path: str | Path = DEFAULT_STATE):
        self.path = Path(path)
        self.data: dict = {"users": [], "groups": [], "sessions": [], "audit": []}
        self.load()

    # -- persistence ---------------------------------------------------
    def load(self) -> None:
        # An empty file is "nothing seeded yet", not a parse error: a scenario's
        # setup.sh may create the state file before the directory is written.
        raw = self.path.read_text().strip() if self.path.exists() else ""
        if raw:
            try:
                loaded = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"{self.path} is not valid JSON: {exc}") from exc
            if isinstance(loaded, dict):
                for key in ("users", "groups", "sessions", "audit"):
                    self.data[key] = loaded.get(key) or []
                return
        self.save()

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, indent=2) + "\n")
        tmp.replace(self.path)

    # -- lookups -------------------------------------------------------
    def user(self, user_id: str) -> dict | None:
        return next((u for u in self.data["users"] if u["id"] == user_id), None)

    def group(self, group_id: str) -> dict | None:
        return next((g for g in self.data["groups"] if g["id"] == group_id), None)

    def require_user(self, user_id: str) -> dict:
        found = self.user(user_id)
        if found is None:
            raise SystemExit(f"no such account: {user_id}")
        return found

    def require_group(self, group_id: str) -> dict:
        found = self.group(group_id)
        if found is None:
            raise SystemExit(f"no such group: {group_id}")
        return found

    def groups_of(self, user_id: str) -> list[str]:
        found = self.user(user_id) or {}
        return list(found.get("groups") or [])

    def sessions_of(self, user_id: str, status: str | None = None) -> list[dict]:
        return [
            s
            for s in self.data["sessions"]
            if s.get("user") == user_id and (status is None or s.get("status") == status)
        ]

    # -- audit ---------------------------------------------------------
    def audit(self, action: str, target: str, actor: str = "helpdesk", reason: str = "") -> None:
        self.data["audit"].append(
            {"at": _now(), "actor": actor, "action": action, "target": target, "reason": reason}
        )

    # -- mutations -----------------------------------------------------
    def set_status(
        self, user_id: str, status: str, *, actor: str, reason: str, failed_attempts=None
    ) -> str:
        user = self.require_user(user_id)
        before = user.get("status", ACTIVE)
        user["status"] = status
        if status == ACTIVE:
            user["failed_attempts"] = 0
        elif failed_attempts is not None:
            # A lockout is a count, not just a flag: a directory that locked an
            # account after five bad sign-ins still has five failed attempts on
            # record, and clearing them is part of putting the account right.
            user["failed_attempts"] = int(failed_attempts)
        action = {"active": "enable", "locked": "lock", "disabled": "disable"}[status]
        self.audit(action, user_id, actor=actor, reason=reason)
        self.save()
        return f"{user_id}: {before} -> {status}"

    def unlock(self, user_id: str, *, actor: str, reason: str) -> str:
        user = self.require_user(user_id)
        user["status"] = ACTIVE
        user["failed_attempts"] = 0
        self.audit("unlock", user_id, actor=actor, reason=reason)
        self.save()
        return f"{user_id}: unlocked, failed attempts reset"

    def add_member(self, user_id: str, group_id: str, *, actor: str, reason: str) -> str:
        self.require_user(user_id)
        self.require_group(group_id)
        user = self.user(user_id)
        memberships = [g for g in (user.get("groups") or [])]
        if group_id not in memberships:
            memberships.append(group_id)
            user["groups"] = sorted(memberships)
        group = self.group(group_id)
        if user_id not in (group.get("members") or []):
            group["members"] = sorted({*(group.get("members") or []), user_id})
        self.audit("add-member", f"{user_id} -> {group_id}", actor=actor, reason=reason)
        self.save()
        return f"{user_id} is now a member of {group_id}"

    def remove_member(self, user_id: str, group_id: str, *, actor: str, reason: str) -> str:
        user = self.require_user(user_id)
        user["groups"] = [g for g in (user.get("groups") or []) if g != group_id]
        group = self.group(group_id)
        if group is not None:
            group["members"] = [m for m in (group.get("members") or []) if m != user_id]
        self.audit("remove-member", f"{user_id} -/-> {group_id}", actor=actor, reason=reason)
        self.save()
        return f"{user_id} removed from {group_id}"

    def revoke_session(self, session_id: str, *, actor: str, reason: str) -> str:
        session = next((s for s in self.data["sessions"] if s["id"] == session_id), None)
        if session is None:
            raise SystemExit(f"no such session: {session_id}")
        session["status"] = "revoked"
        session["revoked_at"] = _now()
        self.audit("revoke-session", session_id, actor=actor, reason=reason)
        self.save()
        return f"session {session_id} revoked"

    # -- seeding -------------------------------------------------------
    def seed(self, users: list[dict], groups: list[dict], sessions: list[dict] | None = None) -> None:
        self.data["users"] = users
        self.data["groups"] = [
            {"id": g["id"], "name": g.get("name", g["id"]), "members": g.get("members", [])}
            for g in groups
        ]
        self.data["sessions"] = sessions or []
        self.data["audit"] = []
        self.save()


# --------------------------------------------------------------------------- #
# seeding presets (the "before" state each identity scenario starts from)
# --------------------------------------------------------------------------- #
PRESETS: dict[str, dict] = {
    "finance-close": {
        "users": [
            {
                "id": "aisha.khan",
                "name": "Aisha Khan",
                "mail": "aisha.khan@ontrak.lab",
                "status": ACTIVE,
                "failed_attempts": 0,
                "groups": ["finance", "finance-reporting"],
            },
            {
                "id": "marco.silva",
                "name": "Marco Silva",
                "mail": "marco.silva@ontrak.lab",
                "status": ACTIVE,
                "failed_attempts": 0,
                "groups": ["finance"],
            },
            {
                "id": "c.nguyen",
                "name": "Chi Nguyen (contractor)",
                "mail": "c.nguyen@ontrak.lab",
                "status": ACTIVE,
                "failed_attempts": 0,
                "groups": ["finance"],
                "contract_ends": "2026-08-31",
            },
        ],
        "groups": [
            {"id": "finance", "name": "Finance", "members": ["aisha.khan", "marco.silva", "c.nguyen"]},
            {"id": "finance-reporting", "name": "Finance reporting", "members": ["aisha.khan"]},
        ],
        "sessions": [],
    },
    "team-move": {
        "users": [
            {
                "id": "marco.silva",
                "name": "Marco Silva",
                "mail": "marco.silva@ontrak.lab",
                "status": ACTIVE,
                "failed_attempts": 0,
                "groups": ["warehouse", "finance-reporting"],
            },
            {
                "id": "aisha.khan",
                "name": "Aisha Khan",
                "mail": "aisha.khan@ontrak.lab",
                "status": ACTIVE,
                "failed_attempts": 0,
                "groups": ["finance", "finance-reporting"],
            },
            {
                "id": "c.nguyen",
                "name": "Chi Nguyen (contractor)",
                "mail": "c.nguyen@ontrak.lab",
                "status": ACTIVE,
                "failed_attempts": 0,
                "groups": ["warehouse"],
                "contract_ends": "2026-08-31",
            },
        ],
        "groups": [
            {"id": "finance", "name": "Finance", "members": ["aisha.khan"]},
            {"id": "finance-reporting", "name": "Finance reporting", "members": ["aisha.khan", "marco.silva"]},
            {"id": "warehouse", "name": "Warehouse", "members": ["marco.silva", "c.nguyen"]},
        ],
        "sessions": [],
    },
}


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def _print_users(directory: Directory, status: str | None = None) -> None:
    width = max([len(u["id"]) for u in directory.data["users"]] + [10])
    for user in directory.data["users"]:
        if status and user.get("status") != status:
            continue
        groups = ", ".join(user.get("groups") or []) or "-"
        print(
            f"{user['id']:<{width}}  {user.get('status', ACTIVE):<9}"
            f"  failed={user.get('failed_attempts', 0):<2}  groups: {groups}"
        )


def _print_json(payload) -> None:
    print(json.dumps(payload, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="OnTrak simulated directory service")
    parser.add_argument("--state", default=os.environ.get("ONTRAK_IDP_STATE", DEFAULT_STATE))
    parser.add_argument("--actor", default=os.environ.get("ONTRAK_IDP_ACTOR", "helpdesk"))
    parser.add_argument("--reason", default="")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    # --actor/--reason exist both globally and per command, because "where do I put
    # the reason?" is exactly the kind of friction that makes people skip it. The
    # per-command copies use SUPPRESS so an unspecified one cannot clobber the global.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--actor", default=argparse.SUPPRESS)
    common.add_argument("--reason", default=argparse.SUPPRESS)

    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("seed")
    seed = sub.add_parser("seed-preset")
    seed.add_argument("preset", choices=sorted(PRESETS))

    sub.add_parser("health")
    sub.add_parser("list-users")
    sub.add_parser("list-groups")
    sub.add_parser("list-sessions")
    sub.add_parser("audit")

    show_user = sub.add_parser("show-user")
    show_user.add_argument("user")
    show_group = sub.add_parser("show-group")
    show_group.add_argument("group")

    unlock = sub.add_parser("unlock", parents=[common])
    unlock.add_argument("user")
    lock = sub.add_parser("lock", parents=[common])
    lock.add_argument("user")
    lock.add_argument(
        "--failed-attempts",
        dest="failed_attempts",
        type=int,
        default=None,
        help="failed sign-ins to leave on record with the lockout",
    )
    disable = sub.add_parser("disable", parents=[common])
    disable.add_argument("user")
    enable = sub.add_parser("enable", parents=[common])
    enable.add_argument("user")

    add = sub.add_parser("add-member", parents=[common])
    add.add_argument("user")
    add.add_argument("group")
    remove = sub.add_parser("remove-member", parents=[common])
    remove.add_argument("user")
    remove.add_argument("group")

    revoke = sub.add_parser("revoke-session", parents=[common])
    revoke.add_argument("session")

    add_session = sub.add_parser("add-session", help="record a live session (used by setup)")
    add_session.add_argument("user")
    add_session.add_argument("--id", dest="session_id", required=True)
    add_session.add_argument("--device", default="unknown-device")

    # Small query verbs so a check script reads like the question it is asking,
    # instead of a pipeline of greps over a JSON document. Exit status is the answer:
    # 0 = yes/active, 1 = no, so `if python3 idp.py in-group ...; then` works.
    status = sub.add_parser("status", help="print an account's status; exit 1 if unknown")
    status.add_argument("user")
    in_group = sub.add_parser("in-group", help="exit 0 when the account is in the group")
    in_group.add_argument("user")
    in_group.add_argument("group")
    active = sub.add_parser("has-active-session", help="exit 0 when a session is still live")
    active.add_argument("user")
    audit_count = sub.add_parser("audit-count", help="count audit entries matching an action/target")
    audit_count.add_argument("--action", default="")
    audit_count.add_argument("--target", default="")
    audit_count.add_argument("--min-reason", type=int, default=0)

    serve = sub.add_parser("serve")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8081)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    directory = Directory(args.state)
    actor = getattr(args, "actor", "helpdesk") or "helpdesk"
    reason = getattr(args, "reason", "") or ""
    command = args.command

    if command == "health":
        print(f"ok accounts={len(directory.data['users'])} sessions={len(directory.data['sessions'])}")
        return 0
    if command == "seed":
        # A neutral directory: enough accounts and groups for a scenario to shape.
        directory.seed(
            users=[
                {"id": "aisha.khan", "name": "Aisha Khan", "status": ACTIVE, "failed_attempts": 0, "groups": ["finance"]},
                {"id": "marco.silva", "name": "Marco Silva", "status": ACTIVE, "failed_attempts": 0, "groups": ["finance"]},
            ],
            groups=[{"id": "finance", "name": "Finance", "members": ["aisha.khan", "marco.silva"]}],
        )
        print(f"seeded {args.state}")
        return 0
    if command == "seed-preset":
        preset = PRESETS[args.preset]
        directory.seed(preset["users"], preset["groups"], preset.get("sessions"))
        print(f"seeded preset {args.preset} ({len(preset['users'])} account(s)) into {args.state}")
        return 0
    if command == "list-users":
        if args.json:
            _print_json(directory.data["users"])
        else:
            _print_users(directory)
        return 0
    if command == "list-groups":
        if args.json:
            _print_json(directory.data["groups"])
        else:
            for group in directory.data["groups"]:
                print(f"{group['id']:<20} {group.get('name', ''):<22} members: {', '.join(group.get('members') or []) or '-'}")
        return 0
    if command == "list-sessions":
        if args.json:
            _print_json(directory.data["sessions"])
        else:
            for session in directory.data["sessions"]:
                print(f"{session['id']:<18} {session.get('user', ''):<16} {session.get('status', ''):<8} {session.get('device', '')}")
        return 0
    if command == "audit":
        entries = directory.data["audit"][-20:]
        if args.json:
            _print_json(entries)
        else:
            for entry in entries:
                print(f"{entry['at']}  {entry['action']:<15} {entry['target']:<28} {entry.get('reason', '')}")
        return 0
    if command == "show-user":
        user = directory.require_user(args.user)
        if args.json:
            _print_json(user)
        else:
            for key in ("id", "name", "mail", "status", "failed_attempts", "groups", "contract_ends"):
                if key in user:
                    print(f"{key}: {user[key]}")
        return 0
    if command == "show-group":
        group = directory.require_group(args.group)
        if args.json:
            _print_json(group)
        else:
            print(f"{group['id']}: {group.get('name', '')} -> {', '.join(group.get('members') or []) or '(no members)'}")
        return 0
    if command == "status":
        user = directory.user(args.user)
        if user is None:
            print("missing")
            return 1
        print(user.get("status", ACTIVE))
        return 0
    if command == "in-group":
        if directory.user(args.user) is None:
            print("no such account")
            return 1
        member = args.group in directory.groups_of(args.user)
        print("yes" if member else "no")
        return 0 if member else 1
    if command == "has-active-session":
        sessions = directory.sessions_of(args.user, status="active")
        print("yes" if sessions else "no")
        return 0 if sessions else 1
    if command == "audit-count":
        matches = [
            entry
            for entry in directory.data["audit"]
            if (not args.action or entry.get("action") == args.action)
            and (not args.target or entry.get("target") == args.target)
            and len(str(entry.get("reason") or "")) >= args.min_reason
        ]
        print(len(matches))
        return 0

    try:
        if command == "unlock":
            print(directory.unlock(args.user, actor=actor, reason=reason))
        elif command == "lock":
            print(
                directory.set_status(
                    args.user,
                    LOCKED,
                    actor=actor,
                    reason=reason,
                    failed_attempts=args.failed_attempts,
                )
            )
        elif command == "disable":
            print(directory.set_status(args.user, DISABLED, actor=actor, reason=reason))
        elif command == "enable":
            print(directory.set_status(args.user, ACTIVE, actor=actor, reason=reason))
        elif command == "add-member":
            print(directory.add_member(args.user, args.group, actor=actor, reason=reason))
        elif command == "remove-member":
            print(directory.remove_member(args.user, args.group, actor=actor, reason=reason))
        elif command == "add-session":
            directory.require_user(args.user)
            directory.data["sessions"].append(
                {
                    "id": args.session_id,
                    "user": args.user,
                    "device": args.device,
                    "issued_at": _now(),
                    "status": "active",
                }
            )
            directory.audit("session-issued", args.session_id, actor=args.user, reason=args.device)
            directory.save()
            print(f"session {args.session_id} issued to {args.user} on {args.device}")
        elif command == "revoke-session":
            print(directory.revoke_session(args.session, actor=actor, reason=reason))
        elif command == "serve":
            serve(directory, args.host, args.port)
        else:  # pragma: no cover - argparse enforces the choices
            print(f"unknown command {command}", file=sys.stderr)
            return 2
    except SystemExit as exc:  # a lookup failure is a normal CLI error
        print(str(exc), file=sys.stderr)
        return 2
    return 0


# --------------------------------------------------------------------------- #
# HTTP API
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    """Read the directory over HTTP; mutate it with the same verbs as the CLI.

    Students are pointed at this so the lab feels like a service they can query
    (``curl localhost:8081/users``) rather than a file they were told to open.
    """

    directory: Directory

    def _send(self, payload, status: int = 200) -> None:
        body = json.dumps(payload, indent=2).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # quieter than the default access log
        return

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's API
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        directory = self.directory
        if path in {"/", "/healthz"}:
            return self._send(
                {
                    "status": "ok",
                    "accounts": len(directory.data["users"]),
                    "groups": len(directory.data["groups"]),
                    "sessions": len(directory.data["sessions"]),
                }
            )
        if path == "/users":
            return self._send(directory.data["users"])
        if path.startswith("/users/"):
            user = directory.user(path.split("/", 2)[2])
            return self._send(user or {"error": "no such account"}, 200 if user else 404)
        if path == "/groups":
            return self._send(directory.data["groups"])
        if path.startswith("/groups/"):
            group = directory.group(path.split("/", 2)[2])
            return self._send(group or {"error": "no such group"}, 200 if group else 404)
        if path == "/sessions":
            return self._send(directory.data["sessions"])
        if path == "/audit":
            return self._send(directory.data["audit"][-50:])
        return self._send({"error": "not found"}, 404)

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0].strip("/").split("/")
        length = int(self.headers.get("Content-Length") or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            payload = {}
        actor = str(payload.get("actor") or "helpdesk")
        reason = str(payload.get("reason") or "")
        directory = self.directory
        try:
            if len(path) == 3 and path[0] == "users" and path[2] == "unlock":
                return self._send({"result": directory.unlock(path[1], actor=actor, reason=reason)})
            if len(path) == 3 and path[0] == "users" and path[2] in {"lock", "disable", "enable"}:
                status = {"lock": LOCKED, "disable": DISABLED, "enable": ACTIVE}[path[2]]
                return self._send(
                    {"result": directory.set_status(path[1], status, actor=actor, reason=reason)}
                )
            if len(path) == 3 and path[0] == "sessions" and path[2] == "revoke":
                return self._send({"result": directory.revoke_session(path[1], actor=actor, reason=reason)})
            if len(path) == 4 and path[0] == "groups" and path[3] == "members":
                if payload.get("remove"):
                    return self._send(
                        {"result": directory.remove_member(payload["user"], path[1], actor=actor, reason=reason)}
                    )
                return self._send(
                    {"result": directory.add_member(payload["user"], path[1], actor=actor, reason=reason)}
                )
        except SystemExit as exc:
            return self._send({"error": str(exc)}, 400)
        return self._send({"error": "not found"}, 404)


def serve(directory: Directory, host: str, port: int) -> None:
    Handler.directory = directory
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"directory service listening on http://{host}:{port} (state {directory.path})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:  # pragma: no cover - interactive path
        pass
    finally:
        server.server_close()


if __name__ == "__main__":  # pragma: no cover - CLI entry point
    raise SystemExit(main())
