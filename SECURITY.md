# Security and privacy

## Supported scope

This is a lightweight coordination dashboard for a trusted research group. It is not a secure GPU allocation authority or a replacement for Slurm policies. Use a dedicated Supabase project and review deployment-specific access rules.

## Defaults

- Demo mode makes no database calls and uses only synthetic in-memory data.
- Production telemetry and reservations are publicly readable, including through the Data API without opening the website.
- Profiles are visible only to their owners; the email allowlist is server-managed.
- Approved emails can create and update their own reservations. Only owners can delete their reservations.
- Only a server secret can write live telemetry and history. Explicit grants and RLS are both present.
- UI capacity checks are advisory. They do not serialize competing requests or enforce pool capacity on the database.
- OAuth identifies the signed-in person; their claimed Slurm username is not independently verified.

## Information that may be published

Cluster and partition names, node names and hardware, own-account Slurm usernames, job IDs, job timings, resource requests, pending reasons, scheduler reservation names/accounts/groups, and reservation display names/reasons. Job names and cross-account usage aggregates are opt-in. Consider sanitizing more fields in `build_snapshot()` or restricting read policies for your site.

A private GitHub repository does not protect a publicly readable Supabase API. Never upload confidential experiment names or reasons to a public deployment.

## Secrets

Keep the server key in `.env.server` with mode `600`, on a trusted account. Do not put server credentials in `VITE_` variables: those are bundled for every visitor. Google OAuth client secrets belong in the Supabase provider settings. Rotate any credential exposed in chat, logs or Git history; deleting a file later is not sufficient.

Run `npm run check:public` before publishing. It is a small guard against common mistakes, not a complete secret scanner or guarantee of anonymization. Review staged files, deployment variables and screenshots manually as well.

## Reporting

Use GitHub's private vulnerability reporting for this repository when available. Do not include active credentials or private cluster data in public issues. Report deployment-specific exposure to the operator of that deployment.
