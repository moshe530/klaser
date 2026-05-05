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

limiter = Limiter(key_func=get_remote_address, default_limits=["200/minute"])
