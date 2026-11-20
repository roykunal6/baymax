// Public app settings. The Supabase URL and anon key are designed to be public: row level
// security in the database (supabase/schema.sql) is what keeps each user's data private.
// Leave them empty to run Baymax without cloud sync (local-only, with the built-in lock screen).
export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';
