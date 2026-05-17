// ─── Klaser Frontend Config ───
// Supabase Auth עם Email + Password. ה-JWT נשלח ל-backend כ-Bearer token.
window.KLASER_CONFIG = {
  // פרודקשן: מסלול יחסי /api מ-Vercel מבצע rewrite אל Render בצד-שרת —
  //   כך הדפדפן לעולם לא פוגע ב-*.onrender.com (חסום ע"י NetFree).
  //   ה-rewrite מוגדר ב-frontend/vercel.json.
  // מקומי: 'http://localhost:8000'
  API_URL: '/api',

  // Supabase Auth (ערכים פומביים — בטוחים ב-frontend)
  // EU region: eu-central-1 (Frankfurt) — migrated from ap-southeast-1
  SUPABASE_URL: 'https://gfabedpkckvrrptbzxhs.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdmYWJlZHBrY2t2cnJwdGJ6eGhzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2OTk4MTcsImV4cCI6MjA5NDI3NTgxN30.-c5mAyyzmP6m-9V_5qjihCT9-Xg91LxmTIl-QkMye3I',
};
