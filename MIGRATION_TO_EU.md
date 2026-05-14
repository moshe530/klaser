# Klaser — Migration to EU Region (Supabase)

**מטרה:** העברת הפרויקט מ-`ap-southeast-1` (Singapore) ל-`eu-central-1` (Frankfurt) כדי להישאר בתוך ה-EEA ולפשט את המדיניות.

**הנחת מוצא:** 0 משתמשים אמיתיים, רק חשבונות בדיקה שלך. לא מעבירים נתונים — מתחילים נקי.

---

## ✅ Pre-flight checklist

- [ ] גישה ל-Supabase Dashboard (החשבון שחתם על ה-DPA)
- [ ] גישה ל-Vercel Dashboard (frontend)
- [ ] גישה ל-Render Dashboard (backend)
- [ ] Node.js מותקן (`node --version`)

---

## שלב 1 — יצירת הפרויקט החדש (5 דק')

1. https://supabase.com/dashboard → **New Project**
2. Name: `klaser-eu` (או כל שם)
3. **Region: `Frankfurt (eu-central-1)`** ← ⚠️ קריטי
4. Database Password: צור חדש, **שמור במקום בטוח**
5. Pricing Plan: Free
6. המתן ~2 דק' עד שהפרויקט מוכן

## שלב 2 — ייצוא הסכמה מהפרויקט הישן (5 דק')

מטרה: לוודא שאין שינויים ידניים שלא בקבצי ה-migration.

**אופציה A — דרך Supabase CLI (מומלץ):**
```bash
# Install once
npm install -g supabase

# Login
supabase login

# Dump schema from OLD project (Singapore)
supabase db dump --linked --schema public,storage -f old_schema.sql --db-url "postgresql://postgres.OLD_REF:OLD_PASSWORD@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres"
```

**אופציה B — דרך Dashboard (אם CLI מסובך):**
1. Old project → **Database** → **Backups** → Download latest backup
2. או: **SQL Editor** → הרץ:
   ```sql
   -- Quick sanity check: list all tables
   select table_schema, table_name from information_schema.tables
   where table_schema in ('public','storage') order by 1,2;
   ```
3. השווה ידנית למה שיש בקבצי `supabase/migrations/`

**אופציה C — שיטה מהירה (אם בטוח שלא שינית):**
דלג על שלב 2 והרץ ישר את 6 קבצי ה-migration בפרויקט החדש.

## שלב 3 — החלת הסכמה על הפרויקט החדש (5 דק')

1. עבור ל-**פרויקט החדש** ב-Frankfurt
2. **SQL Editor** → **New query**
3. הרץ בסדר הזה (copy-paste מכל קובץ):
   - `supabase/migrations/001_init.sql`
   - `supabase/migrations/002_storage.sql`
   - `supabase/migrations/003_ai_pipeline_v41.sql`
   - `supabase/migrations/003_backfill_users.sql`
   - `supabase/migrations/004_user_preferences.sql`
   - `supabase/migrations/005_document_assignment.sql`
4. (אופציונלי) הרץ את `old_schema.sql` במקום, אם הוצאת dump.

**בדיקה:**
```sql
select count(*) from public.users;        -- צריך להחזיר 0
select count(*) from storage.buckets;     -- צריך להחזיר 1 (documents)
```

## שלב 4 — איסוף ה-credentials החדשים (2 דק')

ב-**פרויקט החדש** → **Settings**:

- **API** → `Project URL` + `anon public` key
- **API** → `service_role` key (סודי!)
- **Database** → `JWT Secret`

שמור הכל במקום זמני בטוח (לא ב-Git).

## שלב 5 — עדכון הקוד (אני אעשה — תן לי את הערכים) (5 דק')

קבצים שצריך לעדכן:

| קובץ | שדה | הערה |
|---|---|---|
| `frontend/js/config.js` | `SUPABASE_URL`, `SUPABASE_ANON_KEY` | פומבי |
| Render env vars | `SUPABASE_URL`, `SUPABASE_KEY` (service role), `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET` | סודי |

## שלב 6 — עדכון Render (3 דק')

1. https://dashboard.render.com → klaser backend → **Environment**
2. עדכן 4 משתנים:
   - `SUPABASE_URL` ← החדש
   - `SUPABASE_KEY` ← service_role החדש
   - `SUPABASE_ANON_KEY` ← anon החדש
   - `SUPABASE_JWT_SECRET` ← החדש
3. **Save** → השירות יעשה restart אוטומטי

## שלב 7 — Deploy frontend (3 דק')

לאחר ש-`config.js` עודכן:
```bash
git add frontend/js/config.js
git commit -m "Migrate to EU Supabase region (eu-central-1)"
git push origin main
```
Vercel יעשה deploy אוטומטי.

## שלב 8 — Smoke test (5 דק')

1. פתח את https://klaser.vercel.app ב-Incognito
2. ✅ הרשמה — צור חשבון חדש
3. ✅ העלאת מסמך
4. ✅ חיפוש
5. ✅ Logout + Login מחדש
6. ✅ פתח את ה-Supabase החדש → Table Editor → ראה שהמשתמש והמסמך מופיעים

## שלב 9 — עדכון מדיניות פרטיות (אני אעשה)

- `privacy.html`: `Singapore (ap-southeast-1)` → `Frankfurt (eu-central-1, EU)`
- הסרת סעיף "international transfer" (כי המשתמש הישראלי לא יוצא מ-EU = רמת הגנה נאותה)
- הסרת ההסתמכות על SCCs

## שלב 10 — מחיקת הפרויקט הישן (2 דק')

⚠️ **רק אחרי שכל הבדיקות עברו!**

1. Old project → **Settings** → **General** → Pause / Delete
2. **המתן 24 שעות** לפני מחיקה סופית (ליתר ביטחון)
3. אחרי 24 שעות → מחק לגמרי

---

## 🚨 Rollback plan

אם משהו נשבר:
1. ב-Render: שנה את 4 ה-env vars חזרה לישנים
2. ב-Vercel: `git revert <commit>` + push
3. הפרויקט הישן עדיין חי = אפס downtime

---

## Files affected in code

```
frontend/js/config.js          ← SUPABASE_URL + SUPABASE_ANON_KEY
backend/config.py              ← reads from .env (no hardcoded values)
backend/database.py            ← uses settings.SUPABASE_URL/KEY
backend/auth.py                ← uses settings.SUPABASE_URL/ANON_KEY
backend/services/storage.py    ← uses settings (signed URLs)
backend/services/reminder_scanner.py ← admin client
```

Render env vars handle backend. Only `frontend/js/config.js` needs a code change.
