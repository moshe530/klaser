from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .database import ping
from .routes import admin, documents, reminders

app = FastAPI(title="Klaser API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    # Auto-allow all Netlify previews, Cloudflare Pages, and Cloudflare Workers
    # subdomains so deploy-preview URLs work without manual env changes.
    allow_origin_regex=(
        r"^https://([a-zA-Z0-9-]+\.)?(netlify\.app|pages\.dev|workers\.dev)$"
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
