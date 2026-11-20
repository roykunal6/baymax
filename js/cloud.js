// Shared handle to the signed-in Supabase session (filled in by main.js before the app starts).
export const cloud = { client: null, user: null, sync: null, status: 'local' };
export const cloudEnabled = () => !!cloud.client;
