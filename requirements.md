# Build: cross-platform music link converter (Supabase)

Paste a Spotify track link, get the Apple Music equivalent, and vice versa. Like song.link, but just these two services. This is a hackathon build with a hard one hour limit. Optimise for a working demo over correctness, structure, or completeness.

## Stack (do not deviate)

- **Supabase Edge Function** as the entire app. It serves the HTML and does the resolving. One function, one endpoint.
- **Server-rendered React**, no client bundle. Import `renderToString` from `npm:react-dom/server` and return the HTML string with `Content-Type: text/html`.
- No Express, no Vite, no client-side JS framework, no node_modules. Edge Functions run on Deno.

## Constraints

- **No Apple Developer account.** The Apple Music API requires a paid membership to sign developer tokens, so it is off the table. Use the free, unauthenticated **iTunes Search API** instead.
- **Songs only.** No albums, artists, or playlists. Hardcode the GB storefront.
- Stop and tell me if you are approaching the hour with something unfinished, rather than starting a refactor.

## Supabase specifics that will trip you up

- **JSX config.** Create `supabase/functions/deno.json` with `compilerOptions: { "jsx": "react-jsx", "jsxImportSource": "npm:react" }`. Without this the `.tsx` will not compile.
- **Disable JWT verification.** Edge Functions require an `Authorization` header by default, which would make the page unopenable in a browser. Set `verify_jwt = false` for this function in `supabase/config.toml`, and deploy with `--no-verify-jwt`.
- **Secrets.** Use `Deno.env.get('SPOTIFY_CLIENT_ID')`. Locally these come from `supabase/functions/.env`, in production from `supabase secrets set`. Never `process.env`.
- **Local dev** is `supabase functions serve --env-file supabase/functions/.env`. Deploy with `supabase functions deploy` once it works.
- **No interactivity needed.** Handle the convert action as a plain GET: the form submits `?url=...` back to the same function, which resolves and re-renders. Zero client JS, which removes a whole category of problems.

## Critical API details

Verified as of August 2026. Ignore whatever you remember from training, Spotify shipped breaking changes in February 2026 and most tutorials online are wrong.

### Spotify

- Auth: **client credentials flow** only. `POST https://accounts.spotify.com/api/token` with `grant_type=client_credentials`. No user login, no OAuth redirect, no refresh tokens.
- `GET /v1/tracks/{id}` gives `name`, `artists[]`, `duration_ms`, `album.images[]`, and `external_ids.isrc`. The ISRC field was briefly removed in Feb 2026 and reverted in March, so it is available.
- `GET /v1/search?q=...&type=track&limit=10`. **The limit parameter now maxes out at 10** (it used to be 50) and defaults to 5.
- Playlist endpoints moved from `/playlists/{id}/tracks` to `/playlists/{id}/items`. Not needed here, but do not be surprised by it.
- Cache the access token in a module-level variable. It lasts an hour, which outlives the demo.

### iTunes Search API

- No key, no auth, no headers. Just GET.
- Search: `https://itunes.apple.com/search?term={query}&entity=song&country=GB&limit=5`
- Lookup by ID: `https://itunes.apple.com/lookup?id={trackId}&country=GB`
- Useful fields: `trackName`, `artistName`, `trackId`, `collectionId`, `trackTimeMillis`, `artworkUrl100`, `trackViewUrl`.
- **Rate limit is roughly 20 requests per minute per IP**, enforced erratically with 403 and 429 responses. Handle a non-200 by rendering a readable error rather than crashing. Optional one-liner if you have spare time: a module-level `Map` keyed by input URL, declared outside the request handler, which survives while the isolate stays warm. Do not build anything more elaborate than that.
- It cannot be queried by ISRC. Matching is by string plus duration.

## The two flows

**Spotify link to Apple Music link**
1. Regex the track ID out of the URL (handle `open.spotify.com/track/{id}` with or without query params, and `spotify:track:{id}`)
2. `GET /v1/tracks/{id}` for name, artist, duration, artwork
3. iTunes search with `{artist} {title}`
4. Score the candidates (below), take the winner
5. Build the URL as `https://music.apple.com/gb/album/{collectionId}?i={trackId}`. Construct it yourself rather than trusting `trackViewUrl`, which sometimes returns legacy itunes.apple.com formats.

**Apple Music link to Spotify link**
1. Pull the track ID from the `?i=` query param on the Apple URL
2. `GET itunes.apple.com/lookup?id={trackId}` for name, artist, `trackTimeMillis`
3. Spotify `GET /v1/search?q={artist} {title}&type=track&limit=10`
4. Score, take the winner
5. Return `external_urls.spotify`

Auto-detect direction from the pasted URL rather than making the user choose.

## Matching logic (this is the bit that makes it look good)

Do not just take the first result. Score each candidate:

1. Normalise both sides: lowercase, strip anything in parentheses or brackets, strip `feat.` / `ft.` and everything after, strip punctuation, collapse whitespace.
2. Compare normalised title and normalised primary artist.
3. **Use duration as the tiebreaker.** Compare `trackTimeMillis` against Spotify's `duration_ms`. Prefer candidates within 2000ms. This is what kills the wrong-remaster and live-version mismatches that otherwise make the demo look broken.
4. If nothing scores above a sensible threshold, render a clear "no confident match" rather than a wrong link.

## UI

One page, rendered server-side. A text input, a Convert button, and a result area showing both links with the matched track name, artist, and artwork so the user can eyeball that it found the right song. Copy-to-clipboard can be a tiny inline `onclick` string, that is the only JS allowed. Readable error state if resolution fails.

Minimal but not default-browser ugly: dark background, one accent colour, system font stack.

## Test with these three

- `https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b` (Blinding Lights, The Weeknd)
- Bohemian Rhapsody by Queen, either direction
- Get Lucky by Daft Punk, either direction

Deliberately easy, well-known tracks with unambiguous matches. Do not spend demo time on edge cases.

## Build order

1. Get the function serving any HTML at all, locally, with JWT verification off. Prove the plumbing before anything else.
2. Both resolver functions, verified against real URLs.
3. UI.
4. Deploy.

If time runs out, a working resolver with an ugly page beats a beautiful page that does not resolve.
