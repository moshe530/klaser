"""Shared rate limiter instance.

Lives in its own module so both `main.py` (which registers the middleware
and exception handler) and `routes/*.py` (which decorate individual endpoints)
can import it without creating a circular dependency.

Default storage is in-memory — fine for a single-instance Render deployment.
For multi-worker setups set `RATELIMIT_STORAGE_URI=redis://…` in the env.
"""
from __future__ import annotations

from slowapi import Limiter
from slowapi.util import get_remote_address
from starlette.requests import Request


def _client_ip(request: Request) -> str:
    """Return the real client IP, honoring `X-Forwarded-For` when the
    backend sits behind a trusted reverse proxy (Vercel rewrites, Cloudflare,
    nginx, etc.). Falls back to `request.client.host`.

    Without this, every request appears to come from the proxy's IP and all
    users share a single rate-limit bucket — which means one noisy user can
    DoS everyone else.

    Format of X-Forwarded-For: "client, proxy1, proxy2". We take the LEFTMOST
    entry which is the originating client. Note: trustworthy only when the
    backend is reachable ONLY via the proxy (otherwise a client can spoof).
    """
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        first = fwd.split(",")[0].strip()
        if first:
            return first
    real = request.headers.get("x-real-ip")
    if real:
        return real.strip()
    return get_remote_address(request)


limiter = Limiter(key_func=_client_ip, default_limits=["200/minute"])
