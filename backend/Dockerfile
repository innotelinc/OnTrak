# Ontrak Sync backend.
#
# The image needs an SSH *client* and nothing else beyond Python: every probe and
# every apply reaches the estate through `ssh`/`incus exec` on the configured hosts,
# so there is no Docker socket, no incus binary and no privileged mount here. That
# is a deliberate property — this service can already install packages, and giving
# it the container runtime's socket as well would make it a way to take over the
# host it runs on.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# openssh-client for the probes; ca-certificates so the docker manifest checks and
# any HTTPS call can verify a registry's certificate.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY ontrak ./ontrak
COPY tests ./tests

# The test suite ships with the image on purpose: `docker run --rm <image> python
# tests/run-all.py` is how the deployed artefact is verified, rather than trusting
# that the same commit passed somewhere else.
RUN python -m compileall -q ontrak \
 && python -c "import ontrak.api" \
 && python tests/run-all.py >/dev/null

# /var/lib/ontrak is the SQLite directory; /root/.ssh is where the host key lives.
# Both are volumes in compose, so recreating the container keeps the history.
RUN mkdir -p /var/lib/ontrak

EXPOSE 8420

# The app refuses to start without ONTRAK_API_TOKEN, which is intentional — see
# ontrak/config.py. Nothing permissive is baked in here.
CMD ["uvicorn", "ontrak.api:create_app", "--factory", "--host", "0.0.0.0", "--port", "8420"]
