# קלסר — Klaser

ניהול מסמכים חכם: מסמכים, תזכורות, OCR ו־AI.

## הפעלה מקומית (Backend)

```powershell
# 1. virtualenv
python -m venv .venv
.venv\Scripts\Activate.ps1

# 2. תלויות
pip install -r requirements.txt

# 3. .env
copy .env.example .env
# ערוך .env והכנס SUPABASE_URL + SUPABASE_KEY

# 4. הרצה
uvicorn backend.main:app --reload --port 8000
```

בדיקה: <http://localhost:8000/health>

## מבנה
- `backend/` — FastAPI + Supabase
- `frontend/` — UI סטטי
- `PROJECT.md` — מפרט מלא
