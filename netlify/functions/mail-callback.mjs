// GET /api/mail/callback — where Zoho sends you back after "Add mailbox" → sign in → Allow.
// It only hands the one-time code to the app (in the URL fragment, which isn't sent to servers);
// the signed-in, unlocked app then finishes the connection and stores it encrypted.

export default async (req) => {
  const u = new URL(req.url);
  const keep = new URLSearchParams();
  for (const k of ['code', 'state', 'error', 'accounts-server', 'location']) {
    const v = u.searchParams.get(k);
    if (v) keep.set(k, v.slice(0, 600));
  }
  return new Response(null, { status: 302, headers: { location: `/#zoho-callback=${encodeURIComponent(keep.toString())}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
};

export const config = { path: '/api/mail/callback' };
