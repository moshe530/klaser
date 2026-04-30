# קלסר — ניהול מסמכים חכם

## Frontend
קובץ HTML מלא קיים ב frontend/index.html
כולל: מסמכים, לוח שנה, תזכורות, הגדרות
בנוי responsive למחשב וטלפון

## Backend — Python FastAPI

## DB — Supabase PostgreSQL

טבלאות:
- users (id, email, phone, created_at)
- documents (id, user_id, name, category,
  sub_category, purchase_date, warranty_end,
  amount, file_path, ai_data, created_at)
- reminders (id, user_id, doc_id, type,
  name, remind_at, sent)

## חיבורים:
- Mailgun — קבלת מסמכים במייל
- Resend — שליחת התראות
- Tesseract OCR — חילוץ טקסט
- Claude API (Haiku) — ניתוח AI
- Twilio — וואטסאפ (שלב ב')

## מבנה תיקיות מצופה:
klaser/
  frontend/
    index.html
  backend/
    main.py
    database.py
    models.py
    routes/
      documents.py
      webhooks.py
      reminders.py
    services/
      ai_analyzer.py
      notifications.py
      ocr.py
  PROJECT.md
  .env
  requirements.txt
