"""
Authentication for Klaser.

Approach: extracts the Supabase JWT from the Authorization header
and uses it to build a per-request Supabase client. This way RLS
policies (auth.uid() = user_id) work automatically — the DB itself
enforces ownership, the backend just relays the token.

For dev convenience, if APP_ENV=development AND header `X-Dev-User-Id`
is set, we'll trust it and use the service-role client. NEVER enable
this in production.
"""
from uuid import UUID

from fastapi import Depends, Header, HTTPException, status
from supabase import Client, create_client

from .config import settings
from .database import get_supabase


class AuthContext:
    """Holds the resolved user id + a supabase client scoped to them."""

    def __init__(self, user_id: UUID, client: Client):
        self.user_id = user_id
        self.client = client


def _decode_jwt_sub(token: str) -> UUID:
    """Extract `sub` claim from a Supabase JWT without verifying signature.
    Verification is delegated to Supabase itself (the token is forwarded on
    every request, and PostgREST rejects invalid tokens).
    """
    import base64
    import json

    try:
        parts = token.split(".")
        if len(parts) != 3:
            raise ValueError("malformed jwt")
        payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        return UUID(payload["sub"])
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {e}",
        )


def get_auth(
    authorization: str | None = Header(default=None),
    x_dev_user_id: str | None = Header(default=None, alias="X-Dev-User-Id"),
) -> AuthContext:
    # Dev shortcut — only in development
    if settings.APP_ENV == "development" and x_dev_user_id:
        try:
            uid = UUID(x_dev_user_id)
        except ValueError:
            raise HTTPException(400, "X-Dev-User-Id must be a UUID")
        return AuthContext(user_id=uid, client=get_supabase())

    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Bearer token",
        )

    token = authorization.split(" ", 1)[1].strip()
    user_id = _decode_jwt_sub(token)

    # Build a per-request client that forwards the user's JWT,
    # so RLS sees auth.uid() = the user (for both postgrest AND storage).
    client = create_client(settings.SUPABASE_URL, settings.SUPABASE_ANON_KEY or settings.SUPABASE_KEY)
    client.postgrest.auth(token)
    # Storage uses a separate HTTP session — propagate the JWT there too.
    try:
        client.storage._client.headers["Authorization"] = f"Bearer {token}"
    except Exception:
        pass
    try:
        client.storage.session.headers["Authorization"] = f"Bearer {token}"
    except Exception:
        pass
    return AuthContext(user_id=user_id, client=client)


AuthDep = Depends(get_auth)
