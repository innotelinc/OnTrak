# Sandbox image for the agent's `run_command` tool.
#
#   npm run sandbox:build      # docker build -t coding-agent-sandbox:latest sandbox
#
# Commands are executed inside this image with:
#   --network none --read-only --tmpfs /tmp --cap-drop ALL
#   --security-opt no-new-privileges --memory 2g --cpus 2 --pids-limit 512
#   -v <workspace>:/workspace
#
# so it needs a shell, git and the usual language toolchains, but nothing that
# talks to the network at run time.

FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        build-essential \
        ca-certificates \
        curl \
        git \
        jq \
        make \
        python3 \
        python3-pip \
        python3-venv \
        ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Commands run as the agent's own uid, so HOME has to be somewhere writable that
# is not the read-only root filesystem: /tmp is mounted as tmpfs at run time.
ENV HOME=/tmp \
    CI=1 \
    NPM_CONFIG_CACHE=/tmp/.npm \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /workspace

CMD ["bash", "-lc", "echo 'This image is run by the coding agent, not directly.'"]
