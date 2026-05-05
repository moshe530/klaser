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
from supabase.client import ClientOptions

from .config import settings
from .database import get_supabase


class AuthContext:
    """Holds the resolved user id + a supabase client scoped to them."""

    def __init__(self, user_id: UUID, client: Client):
        self.user_id = user_id
        self.client = client


def _decode_jwt_sub(token: str) -> UUID:
    """Extract `sub` claim from a Supabase JWT.

    If SUPABASE_JWT_SECRET is configured, the signature & expiry are verified
    locally (defense in depth). Otherwise we fall back to unverified decode
    and rely on Supabase to reject invalid tokens downstream.
    """
    try:
        if settings.SUPABASE_JWT_SECRET:
            # Strong path: verify signature, expiry, and audience.
            import jwt as pyjwt
            payload = pyjwt.decode(
                token,
                settings.SUPABASE_JWT_SECRET,
                algorithms=["HS256"],
                audience="authenticated",
                options={"require": ["exp", "sub"]},
            )
        else:
            # Weak path: decode without verifying signature. Still parses
            # exp/sub. Supabase will reject forged tokens on the actual DB
            # call, but this is not cryptographically explicit.
            import base64
            import json
            import time
            parts = token.split(".")
            if len(parts) != 3:
                raise ValueError("malformed jwt")
            payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
            payload = json.loads(base64.urlsafe_b64decode(payload_b64))
            # Manual expiry check
            exp = payload.get("exp")
            if exp and int(exp) < int(time.time()):
                raise ValueError("token expired")
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

    # Build a per-request client where the user's JWT is sent on EVERY
    # subclient (postgrest, storage, functions). This is the only reliable
    # way to make RLS see auth.uid() across all services.
    #
    # SECURITY: We deliberately use ANON_KEY (not SERVICE_ROLE_KEY) so RLS is
    # enforced. If anon key isn't configured, fail loudly — falling back to
    # the service-role key would bypass row-level security.
    if not settings.SUPABASE_ANON_KEY:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SUPABASE_ANON_KEY not configured on server",
        )
    opts = ClientOptions(headers={"Authorization": f"Bearer {token}"})
    client = create_client(
        settings.SUPABASE_URL,
        settings.SUPABASE_ANON_KEY,
        opts,
    )
    # Belt-and-suspenders: also explicitly tell postgrest about the token.
    try:
        client.postgrest.auth(token)
    except Exception:
        pass
    return AuthContext(user_id=user_id, client=client)


AuthDep = Depends(get_auth)
