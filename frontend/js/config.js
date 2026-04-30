// ─── Klaser Frontend Config ───
// בפיתוח: משתמשים ב-X-Dev-User-Id במקום JWT אמיתי.
// בפרודקשן: יוחלף בלוגין דרך Supabase Auth ו-Bearer token.
window.KLASER_CONFIG = {
  // לפיתוח מקומי: 'http://localhost:8000'
  // פרודקשן (Render): 'https://klaser.onrender.com'
  API_URL: 'https://klaser.onrender.com',
  // הדבק כאן את ה-User UID שיצרת ב-Supabase Auth
  DEV_USER_ID: 'e1163349-d533-49f4-8e58-0ac2ef59aefa',
};
