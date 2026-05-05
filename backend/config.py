from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    SUPABASE_URL: str = ""
    SUPABASE_KEY: str = ""
    SUPABASE_ANON_KEY: str = ""
    # Optional: when set, the backend will VERIFY JWT signatures locally
    # (HS256). Without it we still extract the `sub` and rely on Supabase
    # to reject invalid tokens downstream — defense in depth is recommended.
    SUPABASE_JWT_SECRET: str = ""

    APP_ENV: str = "development"
    CORS_ORIGINS: str = "http://localhost:5500,http://127.0.0.1:5500"

    GROQ_API_KEY: str = ""
    MAILGUN_API_KEY: str = ""
    MAILGUN_SIGNING_KEY: str = ""
    RESEND_API_KEY: str = ""
    RESEND_FROM: str = ""  # e.g. "Klaser <noreply@yourdomain.com>"
    CRON_SECRET: str = ""  # protects /admin/scan-reminders
    TWILIO_ACCOUNT_SID: str = ""
    TWILIO_AUTH_TOKEN: str = ""

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


settings = Settings()
