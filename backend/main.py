from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from .config import settings
from .database import ping
from .limiter import limiter
from .routes import account, admin, documents, preferences, reminders

app = FastAPI(title="Klaser API", version="0.1.0")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


# ─── Security headers middleware ─────────────────────────────────────────────
class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Adds standard security headers to every response.

    CSP is intentionally permissive for inline styles (Tailwind-like usage)
    but blocks inline/3rd-party scripts. Adjust connect-src if you add new
    external APIs from the frontend."""

    async def dispatch(self, request: Request, call_next) -> Response:
        response: Response = await call_next(request)
        # Strict transport security — HTTPS only for 1 year
        response.headers.setdefault(
            "Strict-Transport-Security",
            "max-age=31536000; includeSubDomains",
        )
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=()",
        )
        # CSP applies only to HTML responses to avoid breaking JSON consumers;
        # since this is a JSON API only, we still set a safe default for any
        # accidental HTML (e.g. FastAPI auto-generated docs).
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; "
            "img-src 'self' data: blob:; "
            "style-src 'self' 'unsafe-inline'; "
            "script-src 'self'; "
            "connect-src 'self'; "
            "frame-ancestors 'none'",
        )
        return response


app.add_middleware(SecurityHeadersMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    # Auto-allow all Netlify previews, Cloudflare Pages, and Cloudflare Workers
    # subdomains so deploy-preview URLs work without manual env changes.
    allow_origin_regex=(
        # Match any number of subdomain levels — Cloudflare Workers use
        # patterns like `app.account.workers.dev` (two levels).
        r"^https://([a-zA-Z0-9-]+\.)*(netlify\.app|pages\.dev|workers\.dev)$"
    ),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root():
    return {"app": "klaser", "status": "ok", "env": settings.APP_ENV}


@app.get("/health")
def health():
    return {
        "status": "ok",
        "supabase_configured": ping(),
        "env": settings.APP_ENV,
    }


app.include_router(documents.router)
app.include_router(reminders.router)
app.include_router(admin.router)
app.include_router(account.router)
app.include_router(preferences.router)
