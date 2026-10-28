# Deploy your own dashboard

## 1. Configure clusters

Edit `config/clusters.json` before building the frontend or starting an agent:

```json
{
  "title": "Research GPU Dashboard",
  "organization": "Your research group",
  "maxBookingHours": 168,
  "clusters": [{
    "id": "ATLAS",
    "account": "research-lab",
    "members": ["alex", "blair"],
    "pools": [{
      "key": "gpu",
      "label": "GPUs",
      "partitions": ["gpu"],
      "qos": null,
      "capacity": 16
    }]
  }]
}
```

Replace the example account, usernames, partitions, and capacity with values confirmed for your site. Capacity is your group's budget, not every GPU visible in `sinfo`. Cluster IDs and pool keys are stable data identifiers; renaming them does not migrate old reservations. Use the same config in every collector checkout and frontend build.

Pools must have disjoint partition lists. If different partitions expose the same physical GPUs or quotas, do not treat those GPUs as independent budgets. A pool represents one independently countable quota. MIG slices and full GPUs must not share a budget accidentally.

With `qos: null`, the collector uses configured capacity. With a QOS name, it attempts to read that QOS's `MaxTRESPerAccount` GPU limit, otherwise falling back to capacity. Other account associations, QOS combinations, and per-user limits are not automatically resolved. Ask your administrator to confirm the correct budget. The frontend uses fresh telemetry caps when available and the configured values otherwise.

## 2. Create an independent Supabase project

Use a **new project**, not another dashboard's production database. In the SQL editor run the complete file:

[`supabase/migrations/20261027000000_dashboard.sql`](../supabase/migrations/20261027000000_dashboard.sql)

This is an initial migration, not an upgrade or a repeatable reset script. It creates profiles, reservations, live telemetry, history, and an email allowlist. It explicitly grants required API privileges and enables row-level security; it does not depend on automatic table exposure defaults. Keep `public` in the Data API's exposed schemas. See [Supabase Data API security](https://supabase.com/docs/guides/api/securing-your-api).

Run the migration before the first sign-in. In the SQL editor approve exact, lowercase email addresses:

```sql
insert into public.access_allowlist (email, note)
values ('alex@example.org', 'Lab member')
on conflict (email) do nothing;
```

Replace that example address. An empty allowlist permits no reservation creation or updates. A signed-in user can always delete their own reservations, including after removal from the allowlist. The allowlist is not publicly readable.

## 3. Enable Google sign-in

1. Follow [Supabase's Google OAuth setup](https://supabase.com/docs/guides/auth/social-sign-in/auth-google) to create a Google Web OAuth client.
2. Register your project's callback URL, `https://YOUR_PROJECT.supabase.co/auth/v1/callback`, as an authorized redirect URI in Google.
3. Enable Google in Supabase Authentication and enter the OAuth client ID and secret there. Do not put the Google secret in this repo or the frontend.
4. In Supabase URL Configuration, set Site URL to your deployed dashboard URL, including its repository subpath and trailing slash. Add that exact URL and `http://localhost:5173/` to allowed redirects. Add other local ports only when needed.
5. Keep other sign-in providers disabled if you want Google only. Configure Google's consent screen for your intended audience; testing mode restricts who can sign in.

The database checks the authenticated token's email, not the editable profile email, against the allowlist. Profile names come from Google and are copied onto reservations when they are saved. Slurm usernames remain user-entered labels, so this is suitable for a trusted group, not adversarial quota enforcement.

## 4. Configure the frontend

```bash
cp .env.example .env.local
```

Edit `.env.local`:

```dotenv
VITE_DATA_SOURCE=supabase
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
```

Use the project's publishable key, never its secret/service-role key. Every `VITE_` variable is included in browser code. Restart Vite after changing environment variables. Missing production settings fail explicitly; there is no fallback connection to someone else's database.

The allowlist controls writes, not reads: an incognito visitor can read reservations and telemetry. To make data private, change the database read policies **and** add an authenticated-only UI. A private source repository or hidden login button does not make a public Data API private.

## 5. Start collectors

Follow [the Slurm collector guide](slurm-agent.md) once per cluster. Only the collector needs a server secret. Keep one agent per cluster ID; two writers for the same ID overwrite each other's snapshots.

## 6. Host the site

`npm run build` creates `dist/`, which can be hosted on any static HTTPS host. Vite uses relative asset paths for repository-subpath hosting. Runtime settings are baked into the build, so rebuild when they change.

For GitHub Pages:

1. Create your own repository or use this repository as a template.
2. Under Settings > Pages, select **GitHub Actions** as the source.
3. The included Pages workflow defaults to `demo`. To connect your backend, add repository Actions **variables** `VITE_DATA_SOURCE=supabase`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_PUBLISHABLE_KEY` with your public settings.
4. Push to `main` or run the **Deploy dashboard** workflow manually.
5. Update Supabase's allowed redirects to the final Pages URL, then test sign-in and an incognito read.

Do not set `SUPABASE_SERVICE_ROLE_KEY` in frontend Actions variables or secrets. It belongs only on trusted collector machines. GitHub Pages does not run Python or Slurm commands.

## Validation checklist

- Incognito: reservations and telemetry readable; no write access.
- Allowlisted user: create, edit and delete their own reservation.
- Different user: cannot change another user's reservation, even through the API.
- Not allowlisted: cannot create or update a reservation.
- Collector: fresh timestamp, correct account quota, expected GPU partitions, one writer per cluster.
- No credentials or snapshots in commits, screenshots or issue attachments.
