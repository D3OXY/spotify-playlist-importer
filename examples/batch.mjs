import { createPlaylistImporter, PlaylistImportError } from 'spotify-playlist-importer';

const importer = await createPlaylistImporter({ concurrency: 2, timeoutMs: 120_000 });
try {
  const results = await Promise.allSettled(process.argv.slice(2).map(url => importer.extract(url)));
  for (const result of results) {
    if (result.status === 'fulfilled') {
      // Persist this complete snapshot in your app's database transaction.
      console.log(JSON.stringify(result.value));
    } else {
      const error = result.reason;
      console.error(error instanceof PlaylistImportError ? error.code : 'FAILED', error.message);
    }
  }
} finally {
  await importer.close();
}
