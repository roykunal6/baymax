# Baymax: cloud setup

Baymax works on its own (data on one device). These steps add **sync between devices**,
**bank alerts from Gmail**, and **Zoho Mail**. Nothing secret goes in this repository: secrets
live in Netlify's environment variables or in Supabase.

## 1. Supabase (sync + sign-in)
1. Create a project at supabase.com (region: Mumbai).
2. SQL Editor → run [`supabase/schema.sql`](supabase/schema.sql).
3. Authentication → Users → **Add user** → your email + password, **Auto Confirm User** on.
4. Authentication → Sign In / Providers → turn **off** “Allow new users to sign up”.
5. Put the project URL and the **anon** key in [`js/config.js`](js/config.js) (these are public by design;
   row level security keeps the data private).

## 2. Netlify environment variables
Site configuration → Environment variables:

| Name | Value |
|---|---|
| `SUPABASE_URL` | `https://<project>.supabase.co` |
| `SUPABASE_ANON_KEY` | the anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | the service_role key (server only, never in the app) |
| `BAYMAX_USER_ID` | your user's id (Supabase → Authentication → Users) |
| `INGEST_SECRET` | a long random string, also pasted into the Gmail script |
| `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` | from Zoho API Console → Self Client |
| `ZOHO_DC` | `in` for zoho.in accounts (default), `com` for zoho.com |

Redeploy after changing them.

## 3. Bank & card alerts (Gmail)
1. Open script.google.com signed in to the Gmail that receives bank alerts.
2. New project → paste [`tools/gmail-bank-alerts.gs`](tools/gmail-bank-alerts.gs) → set `BAYMAX_SECRET` to `INGEST_SECRET`.
3. Run `setup` once and allow access. It then runs every 15 minutes.
4. In Baymax → Money → Setup, add each credit card with its **last 4 digits** so alerts land on the right card.

## 4. Zoho Mail
1. api-console.zoho.in → **Self Client** → copy Client ID and Client Secret into Netlify (step 2).
2. In Baymax → Mail, follow the on-screen steps: generate a code with scope
   `ZohoMail.accounts.READ,ZohoMail.folders.ALL,ZohoMail.messages.ALL` and paste it.

## Zerodha
No setup. Every Sunday: Zerodha Console → Portfolio → Holdings → Download, then Baymax → Money →
Invest → Upload holdings file. Baymax reminds you.
