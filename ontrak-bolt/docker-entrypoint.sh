#!/bin/sh
#
# ═══════════════════════════════════════════════════════════════════════════
# OnTrak Bolt — container entrypoint.
# ═══════════════════════════════════════════════════════════════════════════
#
# Two steps, in this order, and neither is optional:
#
#  1. **Resolve `vault://` references.** This image is upstream's, which resolves
#     nothing, so without this a `vault://cerulean/ontrak#OMNIROUTE_API_KEY` in the
#     deployment's `.env` arrives in the app as that literal string: the app boots,
#     the model list is empty, and no error says why. The resolver is the stack's
#     own (`scripts/vault-env.mjs`, copied from Genie), driven by `VAULT_ADDR` /
#     `VAULT_TOKEN` (or `VAULT_TOKEN_FILE`) / `VAULT_PREFIX`. A reference that
#     cannot be resolved *stops the container* rather than leaving it up with an
#     empty credential.
#
#  2. **Hand the result to the worker.** The app is a Cloudflare Worker build, and
#     `vite preview` runs it in workerd, an isolate that cannot see the container's
#     environment — `printenv` shows a key the app cannot find. What it *can* see is
#     the `vars` block of `wrangler.jsonc`, which the Cloudflare Vite plugin publishes
#     to the worker as its environment. `scripts/render-worker-vars.mjs` copies the
#     three `OPENAI_LIKE_*` values there at start.
#
# Without `VAULT_*` set, step 1 is a no-op and a plain `.env` value passes straight
# through, so a laptop deployment needs no vault at all.
#
# Every command is `exec`'d, so the server is PID 1 and a stop signal reaches it.

set -eu

if command -v node >/dev/null 2>&1; then
  # The values this product may hold as references. Anything else in `.env` is
  # copied into the container unchanged and never inspected here.
  VAULT_KEYS="OPENAI_LIKE_API_KEY"

  # shellcheck disable=SC2086  # VAULT_KEYS is a space-separated key list
  VAULT_EXPORTS="$(node /app/scripts/vault-env.mjs $VAULT_KEYS)" || exit 1

  if [ -n "$VAULT_EXPORTS" ]; then
    eval "$VAULT_EXPORTS"
  fi

  node /app/scripts/render-worker-vars.mjs
fi

exec "$@"
