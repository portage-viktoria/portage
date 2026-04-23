# Portage — First Integration Milestone

Minimal working setup for connecting a HubSpot portal via OAuth, storing the connection securely, and making the first real API call (listing themes).

## What this milestone proves

- OAuth round-trip with real HubSpot tokens works end-to-end
- Refresh tokens are encrypted at rest with AES-256-GCM
- State tokens prevent CSRF on the authorization flow
- Audit logging captures every meaningful action from day one
- The app can talk to the HubSpot Source Code API on a user's portal

Once you see themes from your real portal appear on the landing page, the plumbing is solid and we can start wiring the real UI and the migration pipeline.

## Setup

### 1. Install dependencies

From the project root:

```bash
npm install
```

### 2. Fill in `.env.local`

Copy this template into a new file called `.env.local` at the project root:

```
HUBSPOT_CLIENT_ID=
HUBSPOT_CLIENT_SECRET=
HUBSPOT_REDIRECT_URI=http://localhost:3000/api/auth/hubspot/callback

NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

PORTAGE_ENCRYPTION_KEY=
PORTAGE_SESSION_SECRET=
```

Fill each in:

- **HubSpot values** — from your public app's "Auth" tab in the developer account
- **Supabase values** — from Project Settings → API in your Supabase dashboard
- **Two secret keys** — generate with `openssl rand -base64 32`, run twice, paste each output separately

After saving `.env.local`, delete your Client Secret from wherever else you had it pasted.

### 3. Run the database schema

In your Supabase dashboard, go to SQL Editor → New Query, paste the contents of `supabase/schema.sql`, and run it. You should see three tables created: `portal_connections`, `oauth_states`, and `audit_log`.

### 4. Start the dev server

```bash
npm run dev
```

Visit `http://localhost:3000`. You should see the Portage landing page with a "Connect HubSpot Portal" button.

### 5. Test the flow

1. Click "Connect HubSpot Portal"
2. You'll be redirected to HubSpot's consent screen
3. Pick a portal to install the app into (you can use your own test portal or Bluleadz's dev portal)
4. Approve the scopes (`content`, `files`, `oauth`)
5. You'll be redirected back to `http://localhost:3000/?connected=<your_hub_id>`
6. The page should show a success banner and, after a moment, a list of themes in that portal

If something fails, check:
- The URL bar for `?connect_error=<reason>` on the landing page
- Your terminal for server-side errors
- Supabase's `audit_log` table — successful connections log a `portal.connected` row

## Architecture notes

- `lib/crypto.ts` — AES-256-GCM envelope encryption; swap this for KMS when we go to production
- `lib/supabase.ts` — two client factories; browser (RLS-respecting) and service role (server-only)
- `lib/audit.ts` — every meaningful action writes here, with sanitized metadata (never raw tokens or secrets)
- `lib/hubspot-oauth.ts` — pure HubSpot API client; no DB, no encryption
- `lib/portal-connections.ts` — bridges DB and OAuth client; every access token goes through `getAccessToken()`
- `app/api/auth/hubspot/start` — initiates OAuth, creates signed state
- `app/api/auth/hubspot/callback` — verifies state, exchanges code, stores connection
- `app/api/portals/[hubId]/themes` — first real HubSpot API call

## What's intentionally not yet built

- Real user authentication (Supabase Auth): every connection currently stores under a placeholder user ID. Next milestone adds proper sign-in.
- Multi-portal picker in the UI: right now one portal is "the connected one"
- Module indexing: we list themes but don't yet pull each theme's modules
- Rate limiter and Sentry: placeholders in the audit log; we'll wire real ones before production

## Known gotchas

- If you get `invalid_grant` on token exchange, the `redirect_uri` in `.env.local` must match exactly what's configured in your HubSpot public app's auth settings — including the trailing slash or lack thereof
- If the theme list is empty, the portal you connected might genuinely have no themes (a fresh dev portal often has only a default one)
- State token errors on callback mean either the state expired (10 minute limit) or the browser dropped something between start and callback — start the flow again