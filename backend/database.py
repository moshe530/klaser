from supabase import create_client, Client
from .config import settings

_client: Client | None = None


def get_supabase() -> Client:
    """Lazy singleton supabase client (service role)."""
    global _client
    if _client is None:
        if not settings.SUPABASE_URL or not settings.SUPABASE_KEY:
            raise RuntimeError(
                "SUPABASE_URL / SUPABASE_KEY missing. Copy .env.example to .env and fill them."
            )
        _client = create_client(settings.SUPABASE_URL, settings.SUPABASE_KEY)
    return _client


def ping() -> bool:
    """Lightweight connectivity check — returns True if client builds."""
    try:
        get_supabase()
        return True
    except Exception:
        return False
