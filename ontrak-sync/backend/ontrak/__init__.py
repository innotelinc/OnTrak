"""Ontrak Sync — Network package and container update monitoring and control.

The package is split so the parts that decide things are separable from the parts
that do things:

  config     what a deployment is (hosts, paths, timeouts, the required token)
  db         SQLite storage, and the lifetime of a finding
  remote     every command that reaches another machine, in one place
  scanners   the pure parsers that decide what is behind
  scan       walks the Network and records findings
  policy     the cron arithmetic and the apply policy
  applier    the only code that changes a machine
  scheduler  the in-process timer
  api        the HTTP surface

Only `remote` and `applier` touch the Network, and only `applier` writes to it.
"""

# This is the number a client sees, not an internal label: `/api/meta` returns it
# and FastAPI puts it in the OpenAPI document. It lives here alone — `api.py` reads
# it rather than repeating it — because a version written down in three places is a
# version that eventually disagrees with itself, which is exactly what happened: this
# said 1.0.0 while the API it belongs to advertised 1.1.0, and the image was tagged a
# third value again.
__version__ = "1.1.0"
