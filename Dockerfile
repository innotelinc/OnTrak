# syntax=docker/dockerfile:1
# ============================================================================
# OnTrak — control plane and student portal.
#
#   docker build -t ontrak .
#   docker run --rm -p 8080:8080 --env-file .env ontrak
#
# What this image is: the Python control plane that talks to Incus, grades the
# machines, serves the portal and signs the Guacamole console links. The guests
# themselves (Windows, Server, Office, Linux) are Incus virtual machines on the
# host — they are not containers and cannot be, so they are deliberately not in
# here. See docs/docker.md for the whole picture.
#
# Two stages: the builder resolves the Python dependencies into a venv, the
# runtime stage copies that venv and the source tree and nothing else. The
# source ships as-is because the portal loads its templates and static files
# relative to the package directory (ontrak/portal/templates), which is also why
# the entrypoint runs from /app rather than from site-packages.
# ============================================================================

# ── builder: dependencies only ──────────────────────────────────────────────
FROM ubuntu:24.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*

# A venv keeps the dependencies in one directory that the runtime stage can copy
# whole, instead of trying to diff /usr/lib/python3/dist-packages.
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

WORKDIR /build
# Only the packaging metadata first: editing ontrak/ then re-running the build
# reuses the layer that installed the dependencies.
COPY pyproject.toml README.md ./
COPY ontrak ./ontrak
RUN python3 -m pip install --upgrade pip \
 && python3 -m pip install .

# ── runtime ─────────────────────────────────────────────────────────────────
FROM ubuntu:24.04 AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/opt/venv/bin:${PATH}" \
    PYTHONPATH=/app \
    ONTRAK_PORTAL__HOST=0.0.0.0 \
    ONTRAK_PORTAL__PORT=8080

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      ca-certificates \
      curl \
      # drives the Incus CLI: the hypervisor stays on the host, this talks to it
      incus-client \
      # the ssh driver provisions and grades Linux guests
      openssh-client \
      # `lab-setup` enters the host's namespaces to install and initialise
      # Incus there, and generates the local secrets before anything starts
      util-linux \
      openssl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
# Scenarios, the workload catalog, the lesson library and the config all live in
# the tree, so the tree is the image. media/ and state/ are volumes.
COPY . /app

# Volumes are created here so a run without them (plain `docker run`) still
# works: the image is usable with no mounts at all.
RUN mkdir -p /app/state /app/media /run/ontrak \
 && chmod +x /app/docker/entrypoint.sh /app/docker/lab-setup.sh \
 && python3 -c "import ontrak, ontrak.portal.app; print('ontrak import ok')"

# The portal listens on 8080; the console gateway (Guacamole) is a separate
# service and never shares this port.
EXPOSE 8080

# /healthz is public on purpose: it reports scenario and catalog counts and is
# what the Compose healthcheck and any load balancer polls.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${ONTRAK_PORTAL__PORT}/healthz" >/dev/null || exit 1

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["serve"]
