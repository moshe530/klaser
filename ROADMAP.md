# 🗺️ Klaser — Roadmap

מסמך חי. עודכן אחרי QA Polish Pass (commit `a1dada7`).

---

## ✅ הושלם בפרודקשן

- **Sprint 0** — בסיס: Auth, AI pipeline (Groq), CRUD מסמכים, קטגוריות דינמיות, תזכורות+cron, לוח שנה, הגדרות
- **Sprint 1** — Cross-device sync (`user_preferences` + `prefs_sync.js`)
- **Sprint 2** — Onboarding לפי סוג חשבון + app-loader + plan usage bar
- **Sprint 3** — Ctrl+K command palette + dark mode מאוחד + bell עם badge
- **Sprint 4** — Camera capture + FAB + person filter chips
- **Sprint 5** — שיוך מסמכים לפרופילים (full stack)
- **QA Polish Pass** — 5 באגים תוקנו

---

## 🔜 בסדר עבודה מומלץ

### A. Smoke test ידני
- אתה: 10 דק' (login, Ctrl+K, dark mode, FAB מובייל, שיוך, sync צולב-מכשירים)
- אני: 10 דק' תיקונים אם צצים

### D. Performance audit
- אתה: 5 דק' (Lighthouse + screenshot)
- אני: 60 דק' (lazy-load תמונות, code-split, font preload, image compression)

### B. PWA + offline
- אתה: 5 דק' (3 אייקונים + אישור deploy)
- אני: 90 דק' (`manifest.json`, service worker, install prompt, offline fallback)

### C. Shared household
- אתה: 15 דק' (מיגרציה + אישור RLS)
- אני: 4 שעות (טבלאות households+invitations, שינוי כל ה-RLS policies, UI הזמנות, endpoint-ים)
- ⚠️ הכי מסוכן בפרויקט — דורש בדיקה כפולה למניעת דליפת מידע בין משפחות

---

## 🎯 רדאר אסטרטגי (חוץ-קוד) — קריטי לפני סקייל

### 1. Analytics בסיסי 📊
**למה דחוף:** כרגע עיוורים — אין מושג איפה אנשים נוטשים, אילו פיצ'רים בשימוש, מה ה-funnel מ-landing → signup → first upload.

**אפשרויות:**
| כלי | יתרון | חיסרון |
|---|---|---|
| **Plausible** | פרטיות (אין cookies, GDPR-ready), קל, $9/חודש | קצת פחות עומק |
| **Google Analytics 4** | חינם, סטנדרט | cookies banner חובה ב-EU, עקומת למידה |
| **PostHog (cloud)** | events + funnels + session replay בחינם עד 1M events | overkill לעכשיו |

**המלצה:** Plausible. 20 דק' התקנה, snippet אחד ב-`index.html`, ולעקוב אחרי 4 events קריטיים: `signup`, `first_upload`, `ai_complete`, `tab_added`.

**זמן:** אתה 5 דק' (חשבון + domain) + אני 15 דק' (snippet + custom events ב-app.js).

### 2. דומיין מותאם 🌐
**למה דחוף:** `c0583229580.workers.dev` נראה לא-בטוח לעין לא-טכנית. אנשים לא יעלו דרכון/חוזה לכתובת עם מספר אקראי.

**אפשרויות:**
- **klaser.co.il** (~₪50/שנה ב-isoc.org.il) — סמכות עברית
- **klaser.app** (~$15/שנה) — טרנדי, גלובלי, HSTS-by-default
- **klaser.com** (אם פנוי, ~$12/שנה)

**המלצה:** **klaser.co.il + klaser.app** ביחד (`klaser.app` מפנה ל-`klaser.co.il`). שניהם < ₪100 בשנה.

**זמן:** אתה 30 דק' (רכישה + DNS A/CNAME ב-Cloudflare Workers settings) + אני 10 דק' (עדכון `KLASER_CONFIG.API_URL` אם רוצים `api.klaser.co.il`, עדכון CORS allowlist).

### 3. דף נחיתה עם waitlist 📧
**למה דחוף:** לפני שמשקיעים שעות בפיצ'רים נוספים — תוכיח ביקוש. 200 אימיילים = הוכחה ש-100 מהם יהיו משלמים אם השירות יהיה טוב.

**מימוש פשוט (MVP):**
- דף landing.html נפרד (או החלפה זמנית של ה-landing הקיים)
- Hero + 3 benefits + screenshot + שדה אימייל
- אימיילים נשמרים ב-Supabase table חדשה `waitlist` (email + source + timestamp)
- מייל אוטומטי דרך Resend: "תודה, אנחנו פותחים בהדרגה — תקבל invite ב-X שבועות"

**אפשרויות מתקדמות:**
- **Tally.so / Typeform** — חינם עד 100 תשובות, hosted, אפס קוד (15 דק')
- **Beehiiv / ConvertKit** — newsletter + waitlist באותו כלי (לכשיהיה תוכן)

**המלצה:** **Tally.so** + הטמעה כ-iframe בדף הקיים. אם הביקוש מאמת — להחליף ל-Supabase native אחרי 50 הרשמות.

**זמן:** אתה 15 דק' (Tally form) + אני 20 דק' (כפתור "הצטרפו לרשימת המתנה" ב-landing + עיצוב).

---

## 📊 סיכום זמנים

| משימה | אתה | אני | ROI |
|---|---|---|---|
| A. Smoke test | 10 דק' | 10 דק' | קריטי |
| **🎯 Waitlist (#3)** | 15 דק' | 20 דק' | ⭐⭐⭐ הוכחת ביקוש |
| **🎯 Analytics (#1)** | 5 דק' | 15 דק' | ⭐⭐⭐ ראות |
| D. Performance audit | 5 דק' | 60 דק' | ⭐⭐ חוויה |
| **🎯 Domain (#2)** | 30 דק' | 10 דק' | ⭐⭐ אמינות |
| B. PWA | 5 דק' | 90 דק' | ⭐⭐ install rate |
| C. Shared household | 15 דק' | 4 שעות | ⭐ premium feature |

**סך זמן עד שאתה יכול לפרסם בפייסבוק/לינקדאין באמת:**
A + Analytics + Domain + Waitlist = **אתה ~60 דק', אני ~55 דק'** = שעה אחת של עבודה משולבת.

---

## 📌 רעיונות עתידיים (לא בתוכנית כרגע)

- WhatsApp reminders (תשתית `channel` enum קיימת)
- Push notifications (VAPID)
- Export PDF/CSV של מסמכים מסוננים
- Multi-language (אנגלית)
- Native mobile app (React Native / Capacitor) — אבל PWA כנראה מספיק
- B2B onboarding מהיר (CSV import של עובדים/לקוחות/ספקים)
