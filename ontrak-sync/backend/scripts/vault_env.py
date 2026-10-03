#!/usr/bin/env python3
"""OnTrak Sync API — Cerulean Vault (SecretOps) boot-time env resolver.

The platform's secret store is **Cerulean Vault** (HashiCorp Vault, KV v2), so
`.env` values may be plain text or `vault://<mount>/<path>#<key>` references —
the same grammar every other product in the stack resolves. A reference is
resolved at container startup (docker-entrypoint.sh), before uvicorn boots, so
every consumer reads the resolved value from `os.environ` unchanged and no
application code knows about references.

Environment contract:
    VAULT_ADDR          base URL, e.g. http://192.168.1.71:8200
    VAULT_TOKEN         this stack's path-scoped token, or
    VAULT_TOKEN_FILE    a file holding it (the Vault CLI's own order)
    VAULT_PREFIX        KV v2 mount point (Cerulean default: cerulean)
    VAULT_NAMESPACE     Enterprise namespaces; unused on OSS Vault
    VAULT_SKIP_VERIFY   "1" to accept a self-signed certificate
    VAULT_CACERT        CA bundle for TLS

CLI:
    python3 scripts/vault_env.py KEY1 [KEY2 ...]

For each KEY whose current value is a `vault://` reference, fetches the key from
Vault and prints a shell-safe `export KEY='<resolved>'` line to stdout so the
entrypoint can `eval` it. Plain (non-reference) values are left alone and produce
no output. Exits non-zero when a reference cannot be resolved, so a container
configured with references but no reachable Vault fails fast instead of booting
with a literal `vault://` value.
"""

from __future__ import annotations

import json
import os
import ssl
import sys
import urllib.error
import urllib.request

REF_PREFIX = "vault://"
LEGACY_REF_PREFIX = "infisical://"
DEFAULT_STORE = "cerulean"
TIMEOUT_SECONDS = 15


def parse_reference(value: str) -> dict | None:
    """Parse `vault://<mount>/<path>#<key>`; returns the parts or None.

    The `#key` fragment is required: a reference without one names a whole
    secret, and a consumer that needs one value cannot guess which.
    """
    if not isinstance(value, str) or not value.startswith(REF_PREFIX):
        return None
    rest = value[len(REF_PREFIX):]
    if "#" not in rest:
        return None
    location, _, key = rest.partition("#")
    key = key.strip()
    mount, _, path = location.partition("/")
    mount = mount.strip()
    path = path.strip().strip("/")
    if not mount or not path or not key:
        return None
    return {"mount": mount, "path": path, "key": key}


def ref_name(value: str) -> str | None:
    parsed = parse_reference(value)
    return f"{parsed['mount']}/{parsed['path']}#{parsed['key']}" if parsed else None


def read_token() -> str:
    direct = os.environ.get("VAULT_TOKEN", "").strip()
    if direct:
        return direct
    path = os.environ.get("VAULT_TOKEN_FILE", "").strip()
    if not path:
        return ""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read().strip()
    except OSError:
        return ""


def config_from_env() -> dict:
    token = read_token()
    cfg = {
        "addr": os.environ.get("VAULT_ADDR", "").rstrip("/"),
        "token": token,
        "namespace": os.environ.get("VAULT_NAMESPACE", ""),
        "skip_verify": os.environ.get("VAULT_SKIP_VERIFY") == "1",
        "cacert": os.environ.get("VAULT_CACERT", ""),
        "store": os.environ.get("VAULT_PREFIX", DEFAULT_STORE),
    }
    cfg["enabled"] = bool(cfg["addr"] and cfg["token"])
    return cfg


def vault_get(cfg: dict, pathname: str) -> tuple[int, dict]:
    url = f"{cfg['addr']}{pathname}"
    headers = {"X-Vault-Token": cfg["token"], "Accept": "application/json"}
    if cfg["namespace"]:
        headers["X-Vault-Namespace"] = cfg["namespace"]
    context = None
    if cfg["addr"].startswith("https:"):
        context = ssl.create_default_context()
        if cfg["skip_verify"]:
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
        elif cfg["cacert"]:
            context.load_verify_locations(cfg["cacert"])
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS, context=context) as response:
            body = response.read().decode("utf-8")
            return response.status, (json.loads(body) if body else {})
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", "replace")
        try:
            return err.code, json.loads(body)
        except ValueError:
            return err.code, {"errors": body[:200]}


def read_secret(cfg: dict, mount: str, path: str, cache: dict) -> dict:
    secret_id = f"{mount}/{path}"
    if secret_id in cache:
        return cache[secret_id]
    status, body = vault_get(cfg, f"/v1/{mount}/data/{path}")
    if status == 404:
        raise RuntimeError(
            f"vault: {secret_id} is not in {cfg['addr']} — seed this stack's "
            "secrets with `python3 scripts/vault-migrate.py --from-env-file .env --keys ...`"
        )
    if status != 200:
        raise RuntimeError(f"vault: reading {secret_id} failed (HTTP {status})")
    outer = body.get("data") if isinstance(body, dict) else None
    if not isinstance(outer, dict) or not isinstance(outer.get("data"), dict):
        raise RuntimeError(
            f"vault: {mount}/ is not answering as KV v2 (the read returned no "
            "data.data nesting) — point VAULT_PREFIX at the KV v2 mount "
            f"(Cerulean's default is `{DEFAULT_STORE}`)"
        )
    cache[secret_id] = outer["data"]
    return outer["data"]


def shell_quote(value: str) -> str:
    return "'" + str(value).replace("'", "'\\''") + "'"


def resolve_keys(cfg: dict, keys: list[str]) -> list[str]:
    references = [k for k in keys if parse_reference(os.environ.get(k, ""))]
    legacy = [k for k in keys if os.environ.get(k, "").startswith(LEGACY_REF_PREFIX)]
    if legacy:
        raise RuntimeError(
            f"vault: {', '.join(legacy)} still hold an infisical:// reference — "
            "Infisical is retired. Move those secrets with scripts/vault-migrate.py "
            "and use vault://<mount>/<path>#<key>."
        )
    if not references:
        return []
    if not cfg["enabled"]:
        raise RuntimeError(
            "vault: values reference Vault but VAULT_ADDR / VAULT_TOKEN (or "
            f"VAULT_TOKEN_FILE) are not set: {', '.join(references)}"
        )
    cache: dict = {}
    lines = []
    for key in references:
        parsed = parse_reference(os.environ[key])
        assert parsed is not None
        secret = read_secret(cfg, parsed["mount"], parsed["path"], cache)
        if parsed["key"] not in secret:
            present = ", ".join(sorted(secret.keys()))
            raise RuntimeError(
                f"vault: {parsed['mount']}/{parsed['path']} has no key "
                f"{parsed['key']} (present: {present})"
            )
        value = secret[parsed["key"]]
        if not isinstance(value, str) or not value:
            raise RuntimeError(
                f"vault: {ref_name(os.environ[key])} is empty — refusing to boot "
                "with an empty credential"
            )
        lines.append(f"export {key}={shell_quote(value)}")
    return lines


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: python3 scripts/vault_env.py KEY1 [KEY2 ...]", file=sys.stderr)
        return 2
    cfg = config_from_env()
    lines = resolve_keys(cfg, argv)
    if lines:
        print(
            f"[sync-api][vault] resolved {len(lines)} secret reference(s) from "
            f"{cfg['store']}: {', '.join(k for k in argv if ref_name(os.environ.get(k, '')))}",
            file=sys.stderr,
        )
        sys.stdout.write("\n".join(lines) + "\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except RuntimeError as err:
        print(f"[sync-api][vault] {err}", file=sys.stderr)
        sys.exit(1)
