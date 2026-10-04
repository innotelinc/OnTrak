"""Ontrak Sync — which registry a docker ref comes from, and how to authenticate.

This sits apart from both the scan and the apply because *both* ask a registry
questions: the scan reads a manifest to compare digests, and the apply pulls an
image. Docker Hub answers an anonymous question out of roughly a hundred requests
per six hours per address, and the two share that allowance — which is why an
update can fail with `429 Too Many Requests` even when the digest checks looked
cheap. So both callers need the same rule about when a credential applies and the
same way of spending it, and that rule lives here rather than in either one.

The credential never becomes an argument, and the login is deliberately left in
place: see `docker_login`.
"""

from __future__ import annotations

from .config import HUB_REGISTRY, Host, RegistryCredential, Settings, normalize_registry
from .remote import Result, docker_in_container


def registry_of(ref: str) -> str:
    """The registry host a docker ref pulls from.

    `ghcr.io/innotelinc/monarch/watchtower` names its registry explicitly;
    `nickfedor/watchtower` does not, and means Docker Hub. Docker's own rule is that
    the first path component is a registry only when it contains a dot or a colon, or
    is `localhost`; anything else is a Hub namespace. Folding every Hub spelling to
    one string is what lets `Settings.credential_for` find the credential by a single
    equality.
    """
    first, _, rest = ref.partition("/")
    if rest and ("." in first or ":" in first or first == "localhost"):
        return normalize_registry(first)
    return HUB_REGISTRY


def docker_login(host: Host, container: str, registry: str,
                 credential: RegistryCredential, settings: Settings) -> Result:
    """`docker login` the host's daemon into `registry` before asking it anything.

    The password goes over **stdin** (`--password-stdin`), never the command line, so
    it cannot be read out of the remote host's process table or shell history. Docker
    Hub takes no server argument; every other registry is named.

    The login is left in place afterwards, on purpose. The daemon keeps it in its own
    config, so it is spent once and then serves every later request from either
    caller: the scan's digest checks and the next apply's pulls both draw on the
    authenticated allowance instead of the anonymous one. Logging in before the
    request is also what makes the *first* scan on a host authenticated, even on a
    host that has never had an update applied to it.
    """
    args = ["login", "--username", credential.username, "--password-stdin"]
    if registry != HUB_REGISTRY:
        args.append(registry)
    return docker_in_container(host, container, args, settings.command_timeout,
                               stdin_text=credential.password)
