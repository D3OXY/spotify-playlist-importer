# Spotify playlist importer

Import every track in a public Spotify playlist through a fresh, unauthenticated Chromium context. TypeScript library and CLI, with a shared browser, bounded concurrency, cancellation, and completeness checks.

The importer scrolls Spotify's virtualized track list, preserves playlist positions and duplicate titles, and observes the page's own network responses for additional metadata and verification. It supplies no login, OAuth flow, developer credentials, or official Spotify Web API requests. Spotify's web player still obtains its own anonymous guest tokens and calls internal endpoints.

## Setup

Requires Node.js 22 or later and pnpm.

```sh
git clone git@github.com:D3OXY/spotify-playlist-importer.git
cd spotify-playlist-importer
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

On Linux hosts missing Chromium's system libraries, run `pnpm exec playwright install-deps chromium` during provisioning.

## Command line

```sh
pnpm run extract 'https://open.spotify.com/playlist/2gWVzPkdkpeGfMdcAkTBLv' --out output/my-playlist
```

The argument accepts a Spotify playlist URL, a 22-character ID, or a `spotify:playlist:` URI. The URL is validated and reduced to an ID before navigation, so callers cannot turn the importer into an arbitrary URL fetcher. Only public playlists are supported.

Successful imports write:

- `songs.txt`, one title per line in playlist order.
- `playlist.json`, the complete snapshot, track metadata, and verification details.

Incomplete imports write `songs.partial.txt` and `playlist.partial.json`, preserving any previous complete export. JSON preserves titles verbatim; the text export replaces embedded line breaks with spaces to maintain one title per line. Files are replaced individually through temporary files. For atomic publication of an entire snapshot, use your application's database transaction.

`--timeout 180000` overrides the default two-minute deadline. The deadline includes queue time. Exit codes are 0 for complete, 2 for incomplete, 124 for timeout, 130 for cancellation, and 1 for other failures. Progress goes to stderr; the completion summary goes to stdout. Navigation, cancellation, and timeout failures do not produce a new partial export.

## Use in an app

Install the repository as a Git dependency using an account with access to this private repository:

```sh
pnpm add git+ssh://git@github.com/D3OXY/spotify-playlist-importer.git
pnpm exec playwright install chromium
```

The package's `prepare` script builds its JavaScript and declarations when installed from Git. If your package manager blocks dependency build scripts, explicitly permit this package's build or build and install its tarball with `pnpm run build && pnpm pack`.

```ts
import { createPlaylistImporter, PlaylistImportError } from 'spotify-playlist-importer';

// Create once in your worker process, rather than once per HTTP request.
const importer = await createPlaylistImporter({ concurrency: 2, timeoutMs: 120_000 });

try {
  const playlist = await importer.extract(playlistUrl, {
    signal: abortController.signal,
    onProgress: ({ collected, expected }) => {
      console.log(`${collected}/${expected}`);
    },
  });

  // A fulfilled import has passed completeness checks.
  await savePlaylistTransaction(playlist);
} catch (error) {
  if (error instanceof PlaylistImportError) {
    console.error(error.code, error.result?.missingPositions);
    // INCOMPLETE errors include partial data in error.result.
  } else {
    throw error;
  }
}

// Call during worker shutdown. This cancels queued and active imports.
await importer.close();
```

The database functions and job-status updates belong to your app. `examples/batch.mjs` is a runnable example that accepts several playlist URLs and imports them with a shared browser.

Each result includes:

```ts
{
  id: string;
  url: string;
  title: string;
  importedAt: string;
  expectedCount: number;
  complete: boolean;
  tracks: Array<{
    position: number;       // One-based playlist position.
    spotifyId: string | null;
    title: string;
    artists: string[];
    durationMs: number | null;
  }>;
  missingPositions: number[];
  verification: { /* totals, cookie count, network batches, conflicts */ };
}
```

Artist names and durations may be unavailable. Duration falls back to the DOM's rounded display value when exact milliseconds are absent from observed network data. Titles are never deduplicated. Spotify IDs identify recordings; `(importId, position)` identifies each occurrence within a snapshot.

`PlaylistImportError.code` is one of `INCOMPLETE`, `ABORTED`, `TIMEOUT`, `CLOSED`, `UNAVAILABLE`, or `PAGE_CHANGED`. Invalid input or configuration raises `TypeError` or `RangeError`. Other browser or application callback failures retain their original error. Use `Promise.allSettled` for independent imports so one failure does not discard the other results.

You can supply an existing Playwright `browser` in the factory options. The importer still creates fresh contexts and closes them, but leaves the supplied browser open when the importer closes. Otherwise it owns and closes its Chromium process. `launchOptions` passes Chromium configuration through to Playwright.

## Multiple users

Use one importer per worker process. The concurrency limit queues excess calls in memory; it is not a durable job queue or a global limit across worker processes.

For an initial deployment, use your app's database for durable import jobs and completed snapshots:

1. Parse the playlist ID and check your cache.
2. Join an existing job for that playlist, or create one.
3. Have a worker call `extract` and report progress.
4. Publish the completed snapshot in one database transaction.
5. Let playback read the saved snapshot independently of Chromium.

Share cached results only for public playlists and apply your own expiry and explicit-refresh rules. Limit job submissions per user and total queue length in the app. Add bounded retries with backoff at the job layer; this library does not retry entire imports or rotate proxies. Cache reuse, job deduplication, and refresh policies stay in the app so they can use its database and user model.

The worker needs a normal Node runtime with Chromium and outbound access to Spotify. Persistent workers avoid paying browser startup cost on every import. No server, database, Redis instance, or hosted browser service is required by this package.

## Verification and limits

An import succeeds only when all positions from 1 through the displayed total are present, the displayed total remains unchanged, and observed position, name, count, and revision checks have no conflicts. Recommendations are excluded by scoping collection to the playlist grid. The script collects overlapping groups while scrolling, rather than jumping to the bottom or assuming the first 100 tracks are complete.

Network observation is optional verification. If Spotify changes that response format, DOM extraction can still complete; `verification.networkCount` tells you how many positions were independently observed. The importer never replays internal requests, stores guest tokens, or exports raw HTML or authorization headers. Revision checks apply when a revision is exposed in the responses; they cannot guarantee a snapshot of an actively edited playlist when Spotify supplies no revision.

The prior investigation found that ordinary HTTP HTML exposed 30 titles and embed JSON exposed 100. Adding offset parameters returned the same prefixes. The verified full-list method uses desktop Chromium scrolling. Spotify can change its page structure, guest access, or rate limits, so monitor failed imports and keep the last complete snapshot available. Extracted metadata does not provide audio playback.

## Development

```sh
pnpm run typecheck
pnpm test
```

Tests run Chromium against intercepted HTML and network fixtures. They cover virtualized lazy loading beyond 100, duplicate titles, truncation, concurrent context isolation, cancellation, deadlines, shutdown, unavailable playlists, and empty playlists. They do not contact Spotify. Actual live results are recorded separately in `validation.json`.

The source uses strict TypeScript. `src/importer.ts` is the public package entry; page extraction and input parsing remain separate modules. Generated output, browser captures, tokens, and personal exports are excluded from Git.
