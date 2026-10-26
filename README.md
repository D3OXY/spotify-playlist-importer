# Spotify playlist importer

Reusable TypeScript library and CLI for complete public Spotify playlists. Uses Playwright and Chromium without login, OAuth, developer credentials, or direct official Web API calls. Spotify's page uses its own anonymous guest session.

Verified with all 275 tracks, including two simultaneous imports. Preserves order and duplicate titles, and includes artists, durations, and Spotify track IDs.

## Run

Requires Node.js 22+ and pnpm.

```sh
git clone git@github.com:D3OXY/spotify-playlist-importer.git
cd spotify-playlist-importer
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm run extract 'https://open.spotify.com/playlist/2gWVzPkdkpeGfMdcAkTBLv' --out output/playlist
```

Writes `songs.txt` and `playlist.json`. Incomplete imports write separate `.partial` files and exit with status 2. On Linux, install missing system libraries with `pnpm exec playwright install-deps chromium`.

## Reuse

```js
import { createPlaylistImporter } from './dist/importer.js';

const importer = await createPlaylistImporter({ concurrency: 2 });
try {
  const playlist = await importer.extract(playlistUrl);
  console.log(playlist.tracks);
} finally {
  await importer.close();
}
```

Reuse one importer per worker. Each import gets a fresh browser context. Pass `signal`, `timeoutMs`, or `onProgress` to `extract` as needed. Failed completeness checks throw `PlaylistImportError` with partial data in `error.result`. Your app owns caching and durable jobs.

For another app, run `pnpm pack` here and install the resulting tarball with `pnpm add /path/to/spotify-playlist-importer-1.0.0.tgz`. Import from `spotify-playlist-importer` in that app.

Source starts at `src/importer.ts`. All 11 local tests passed. Run `pnpm run typecheck` and `pnpm test` to check changes. Live extraction results are recorded in `validation.json`.
