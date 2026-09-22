# What the gateway proxies, for both of its listeners.
#
# Included inside a `server` block rather than repeated: the plain-HTTP origin and
# the TLS one have to proxy *identically*, and two copies drift apart the moment
# one of them is fixed. `map` and `server` directives are not allowed in this
# context, so the host fallback each listener needs is declared in the listener's
# own file (`nginx.conf`, `nginx.tls.conf`).

# A ticket can carry a screenshot and a scenario can carry a script. Larger than
# an upload should ever be, smaller than «the proxy is the disk quota».
client_max_body_size 64m;

proxy_http_version 1.1;
# `$forwarded_host` (from each listener's map) is the raw `Host` header, port and
# all — not nginx's `$host`, which drops it. That matters here: this stack is
# reached on one port (`:8080` plain, `:8443` with TLS), and the portal derives the
# console URL from the address the student's browser used (`guac.base_url: auto`).
# Drop the port and the console iframe is pointed at the wrong one — a frame that
# never opens, with nothing on the page explaining why.
proxy_set_header Host $forwarded_host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
# Which scheme the *browser* used. TLS is terminated in this container, so
# `$scheme` is already the right answer — https on the TLS listener — and the
# console link comes back https without a second proxy in front telling us so.
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $forwarded_host;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;

# A student's screen can sit unchanged for minutes. The 60s default would cut
# them off mid-scenario, which reads to them as the range breaking.
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;

location /guacamole/ {
    # The path is passed through unchanged: the webapp is deployed at
    # /guacamole/ inside its container and generates base-relative URLs from
    # there. Rewriting it would break every one of them.
    #
    # This stack always runs the console, so a literal upstream is right here:
    # nginx resolves it at startup and will not start at all if it is missing,
    # which is the failure that makes the requirement explicit.
    proxy_pass http://guacamole:8080;

    # The tunnel is a stream of screen updates. Buffering it adds latency to
    # every keystroke and every repaint.
    proxy_buffering off;
    # Let the upstream decide when the tunnel ends, not a client that walked
    # away from a laptop.
    proxy_ignore_client_abort on;
}

location / {
    proxy_pass http://portal:8080;
}
