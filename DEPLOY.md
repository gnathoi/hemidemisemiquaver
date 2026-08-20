# Deployment

`maga2026.app` serves `docs/index.html`; `/api/convert` on that host is rewritten
to the Supabase Edge Function, so the browser only ever talks to one origin.

```
maga2026.app ──▶ Vercel project "hemidemisemiquaver" (team: nathaniel-heys-projects)
                 ├─ /             docs/index.html          (static)
                 └─ /api/convert  ─rewrite─▶ uecupxbggzxgkizitsci.supabase.co
www.maga2026.app ──308──▶ maga2026.app
```

Both halves deploy from GitHub Actions. Vercel's own Git integration is
**disconnected on purpose** — if you reconnect it, every push deploys twice.

| Workflow | Triggers on | Does |
| --- | --- | --- |
| `.github/workflows/deploy-site.yml` | `docs/**`, `vercel.json` | `vercel build` + `vercel deploy --prebuilt --prod`, then smoke-tests both hostnames and the API rewrite |
| `.github/workflows/deploy-function.yml` | `supabase/**` | `supabase functions deploy convert --use-api`, then smoke-tests the function |

Both also accept `workflow_dispatch` for a manual run.

## Required repository secrets

| Secret | Where to get it |
| --- | --- |
| `VERCEL_TOKEN` | <https://vercel.com/account/settings/tokens> — scope it to the *Nathaniel Hey's projects* team |
| `SUPABASE_ACCESS_TOKEN` | <https://supabase.com/dashboard/account/tokens> — must belong to the account that owns project `uecupxbggzxgkizitsci` |

```sh
gh secret set VERCEL_TOKEN
gh secret set SUPABASE_ACCESS_TOKEN
```

Non-secret IDs (Vercel org/project, Supabase project ref) are inlined in the
workflow files — they are identifiers, not credentials.

## Spotify credentials

These live in Supabase, not in GitHub. Set once per project:

```sh
supabase secrets set SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... \
  --project-ref uecupxbggzxgkizitsci
```

## Local

```sh
supabase functions serve --env-file supabase/functions/.env   # the function
vercel dev                                                    # site + /api rewrite
```

Opening `docs/index.html` straight off disk also works — the page falls back to
calling the Supabase function directly when it is not served from a proxied host.
