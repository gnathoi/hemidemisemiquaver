/** @jsxImportSource npm:react */
import React from "npm:react";
import { renderToString } from "npm:react-dom/server";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const STOREFRONT = "GB";

// ---------------------------------------------------------------------------
// Spotify auth — client credentials flow, cached in a module-level variable.
// ---------------------------------------------------------------------------
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getSpotifyToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.value;
  }
  const id = Deno.env.get("SPOTIFY_CLIENT_ID");
  const secret = Deno.env.get("SPOTIFY_CLIENT_SECRET");
  if (!id || !secret) {
    throw new Error("Spotify credentials are not configured (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET).");
  }
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(`${id}:${secret}`),
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    throw new Error(`Spotify auth failed (${res.status}).`);
  }
  const data = await res.json();
  // Refresh a minute early to be safe.
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return cachedToken.value;
}

// ---------------------------------------------------------------------------
// Normalisation + scoring
// ---------------------------------------------------------------------------
function normalise(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ") // strip parenthesised
    .replace(/\[[^\]]*\]/g, " ") // strip bracketed
    .replace(/\b(feat\.?|ft\.?)\b.*$/i, " ") // strip feat/ft and after
    .replace(/[^\w\s]/g, " ") // strip punctuation
    .replace(/\s+/g, " ")
    .trim();
}

type Track = {
  title: string;
  artist: string;
  durationMs: number;
};

type Candidate = {
  title: string;
  artist: string;
  durationMs: number;
  raw: unknown;
};

// Returns { candidate, score } for the best match, or null if nothing confident.
function pickBest(source: Track, candidates: Candidate[]) {
  const srcTitle = normalise(source.title);
  const srcArtist = normalise(source.artist);

  let best: { candidate: Candidate; score: number } | null = null;

  for (const c of candidates) {
    const cTitle = normalise(c.title);
    const cArtist = normalise(c.artist);

    let score = 0;
    // Title match
    if (cTitle === srcTitle) score += 3;
    else if (cTitle.includes(srcTitle) || srcTitle.includes(cTitle)) score += 2;

    // Artist match
    if (cArtist === srcArtist) score += 2;
    else if (cArtist.includes(srcArtist) || srcArtist.includes(cArtist)) score += 1;

    // Duration tiebreaker
    if (source.durationMs && c.durationMs) {
      const diff = Math.abs(source.durationMs - c.durationMs);
      if (diff <= 2000) score += 2;
      else if (diff <= 5000) score += 1;
      else if (diff > 15000) score -= 1;
    }

    if (!best || score > best.score) best = { candidate: c, score };
  }

  // Threshold: need at least a decent title + some corroboration.
  if (!best || best.score < 4) return null;
  return best;
}

// ---------------------------------------------------------------------------
// Direction detection + ID extraction
// ---------------------------------------------------------------------------
function spotifyTrackId(url: string): string | null {
  const m =
    url.match(/open\.spotify\.com\/track\/([a-zA-Z0-9]+)/) ||
    url.match(/spotify:track:([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}

function appleTrackId(url: string): string | null {
  const m = url.match(/[?&]i=(\d+)/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------
type Result = {
  matchedTitle: string;
  matchedArtist: string;
  artwork: string;
  spotifyUrl: string;
  appleUrl: string;
};

async function spotifyToApple(id: string): Promise<Result> {
  const token = await getSpotifyToken();
  const res = await fetch(`https://api.spotify.com/v1/tracks/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Spotify track lookup failed (${res.status}).`);
  const track = await res.json();

  const source: Track = {
    title: track.name,
    artist: track.artists?.[0]?.name ?? "",
    durationMs: track.duration_ms,
  };
  const spotifyArtwork = track.album?.images?.[0]?.url ?? "";
  const spotifyUrl = track.external_urls?.spotify ?? `https://open.spotify.com/track/${id}`;

  const query = `${source.artist} ${source.title}`;
  const itres = await fetch(
    `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&country=${STOREFRONT}&limit=5`,
  );
  if (!itres.ok) throw new Error(`iTunes search is rate-limited or unavailable (${itres.status}). Try again shortly.`);
  const itdata = await itres.json();

  const candidates: Candidate[] = (itdata.results ?? []).map((r: any) => ({
    title: r.trackName,
    artist: r.artistName,
    durationMs: r.trackTimeMillis,
    raw: r,
  }));

  const best = pickBest(source, candidates);
  if (!best) throw new NoMatchError(source);
  const win: any = best.candidate.raw;

  return {
    matchedTitle: win.trackName,
    matchedArtist: win.artistName,
    artwork: spotifyArtwork || win.artworkUrl100 || "",
    spotifyUrl,
    appleUrl: `https://music.apple.com/gb/album/${win.collectionId}?i=${win.trackId}`,
  };
}

async function appleToSpotify(id: string): Promise<Result> {
  const itres = await fetch(
    `https://itunes.apple.com/lookup?id=${id}&country=${STOREFRONT}`,
  );
  if (!itres.ok) throw new Error(`iTunes lookup is rate-limited or unavailable (${itres.status}). Try again shortly.`);
  const itdata = await itres.json();
  const song = (itdata.results ?? [])[0];
  if (!song) throw new Error("Could not find that track on Apple Music.");

  const source: Track = {
    title: song.trackName,
    artist: song.artistName,
    durationMs: song.trackTimeMillis,
  };
  const appleArtwork = song.artworkUrl100 ?? "";
  const appleUrl = `https://music.apple.com/gb/album/${song.collectionId}?i=${song.trackId}`;

  const token = await getSpotifyToken();
  const query = `${source.artist} ${source.title}`;
  const res = await fetch(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=10`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Spotify search failed (${res.status}).`);
  const data = await res.json();

  const items = data.tracks?.items ?? [];
  const candidates: Candidate[] = items.map((t: any) => ({
    title: t.name,
    artist: t.artists?.[0]?.name ?? "",
    durationMs: t.duration_ms,
    raw: t,
  }));

  const best = pickBest(source, candidates);
  if (!best) throw new NoMatchError(source);
  const win: any = best.candidate.raw;

  return {
    matchedTitle: win.name,
    matchedArtist: win.artists?.[0]?.name ?? "",
    artwork: win.album?.images?.[0]?.url || appleArtwork || "",
    spotifyUrl: win.external_urls?.spotify ?? "",
    appleUrl,
  };
}

class NoMatchError extends Error {
  constructor(source: Track) {
    super(`No confident match found for "${source.title}" by ${source.artist}.`);
    this.name = "NoMatchError";
  }
}

// Optional warm-isolate cache keyed by input URL.
const resultCache = new Map<string, Result>();

async function resolve(url: string): Promise<Result> {
  const trimmed = url.trim();
  if (resultCache.has(trimmed)) return resultCache.get(trimmed)!;

  const spId = spotifyTrackId(trimmed);
  const apId = appleTrackId(trimmed);

  let result: Result;
  if (spId) {
    result = await spotifyToApple(spId);
  } else if (apId && /music\.apple\.com/.test(trimmed)) {
    result = await appleToSpotify(apId);
  } else {
    throw new Error("That does not look like a Spotify track or Apple Music song link.");
  }

  resultCache.set(trimmed, result);
  return result;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
const styles = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #0e0e12; color: #e8e8ea;
    display: flex; flex-direction: column; align-items: center;
    padding: 48px 20px;
  }
  .wrap { width: 100%; max-width: 560px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  p.sub { margin: 0 0 28px; color: #9a9aa5; font-size: 14px; }
  form { display: flex; gap: 8px; margin-bottom: 24px; }
  input[type=text] {
    flex: 1; padding: 12px 14px; border-radius: 10px;
    border: 1px solid #2a2a33; background: #17171d; color: #e8e8ea; font-size: 15px;
  }
  input[type=text]:focus { outline: none; border-color: #1db954; }
  button {
    padding: 12px 18px; border-radius: 10px; border: none; cursor: pointer;
    background: #1db954; color: #06120a; font-weight: 600; font-size: 15px;
  }
  button:hover { filter: brightness(1.08); }
  .card {
    background: #17171d; border: 1px solid #2a2a33; border-radius: 14px;
    padding: 20px; display: flex; gap: 16px; align-items: center; margin-bottom: 18px;
  }
  .card img { width: 88px; height: 88px; border-radius: 10px; object-fit: cover; background: #222; }
  .card .meta { min-width: 0; }
  .card .title { font-size: 17px; font-weight: 600; margin: 0 0 2px; }
  .card .artist { color: #9a9aa5; font-size: 14px; margin: 0; }
  .links { display: flex; flex-direction: column; gap: 10px; }
  .link-row {
    display: flex; align-items: center; gap: 10px;
    background: #17171d; border: 1px solid #2a2a33; border-radius: 10px; padding: 12px 14px;
  }
  .link-row .svc { font-weight: 600; width: 96px; flex-shrink: 0; }
  .link-row a { color: #7db3ff; text-decoration: none; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .link-row .copy {
    background: #2a2a33; color: #e8e8ea; padding: 6px 10px; font-size: 12px; font-weight: 500;
    border-radius: 7px; flex-shrink: 0;
  }
  .error { background: #2a1416; border: 1px solid #5c2126; color: #ffb3ba; padding: 14px 16px; border-radius: 10px; font-size: 14px; }
  .foot { margin-top: 32px; color: #55555f; font-size: 12px; }
`;

function LinkRow({ svc, url }: { svc: string; url: string }) {
  const btnId = `c_${svc.replace(/\s/g, "")}`;
  return (
    <div className="link-row">
      <span className="svc">{svc}</span>
      <a href={url} target="_blank" rel="noreferrer">{url}</a>
      <button
        type="button"
        className="copy"
        id={btnId}
        onClick={`navigator.clipboard.writeText('${url.replace(/'/g, "\\'")}');this.textContent='Copied';setTimeout(()=>this.textContent='Copy',1200)`}
      >
        Copy
      </button>
    </div>
  );
}

function Page({ url, result, error }: { url: string; result: Result | null; error: string | null }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Music Link Converter</title>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
      </head>
      <body>
        <div className="wrap">
          <h1>Music Link Converter</h1>
          <p className="sub">Paste a Spotify track or Apple Music song link. Get the other one.</p>
          <form method="GET">
            <input
              type="text"
              name="url"
              defaultValue={url}
              placeholder="https://open.spotify.com/track/…"
              autoComplete="off"
            />
            <button type="submit">Convert</button>
          </form>

          {error ? <div className="error">{error}</div> : null}

          {result ? (
            <>
              <div className="card">
                {result.artwork ? <img src={result.artwork} alt="" /> : null}
                <div className="meta">
                  <p className="title">{result.matchedTitle}</p>
                  <p className="artist">{result.matchedArtist}</p>
                </div>
              </div>
              <div className="links">
                <LinkRow svc="Spotify" url={result.spotifyUrl} />
                <LinkRow svc="Apple Music" url={result.appleUrl} />
              </div>
            </>
          ) : null}

          <div className="foot">iTunes Search API · GB storefront · songs only</div>
        </div>
      </body>
    </html>
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const input = url.searchParams.get("url") ?? "";

  let result: Result | null = null;
  let error: string | null = null;

  if (input.trim()) {
    try {
      result = await resolve(input);
    } catch (e) {
      error = e instanceof Error ? e.message : "Something went wrong.";
    }
  }

  const html = "<!DOCTYPE html>" + renderToString(<Page url={input} result={result} error={error} />);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
});
