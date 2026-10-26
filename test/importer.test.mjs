import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { chromium } from 'playwright';
import { createPlaylistImporter, parsePlaylistId, PlaylistImportError } from '../dist/importer.js';
import { fixtureBrowser, playlistId } from './fixture.mjs';

let chromiumBrowser;
before(async () => { chromiumBrowser = await chromium.launch(); });
after(async () => { await chromiumBrowser?.close(); });

test('accepts Spotify IDs, URIs and shared URLs; rejects arbitrary hosts and credentials', () => {
  for (const value of [playlistId, `spotify:playlist:${playlistId}`, `https://open.spotify.com/playlist/${playlistId}?si=share`]) {
    assert.equal(parsePlaylistId(value), playlistId);
  }
  for (const value of [`http://localhost/playlist/${playlistId}`, `https://open.spotify.com.evil.test/playlist/${playlistId}`, `https://user:password@open.spotify.com/playlist/${playlistId}`, `https://open.spotify.com:444/playlist/${playlistId}`, 'invalid']) {
    assert.throws(() => parsePlaylistId(value), TypeError);
  }
});

test('collects virtualized, lazy-loaded positions beyond 100 and preserves repeated titles', async () => {
  const fixture = await fixtureBrowser(chromiumBrowser);
  const importer = await createPlaylistImporter({ browser: fixture.browser });
  try {
    const result = await importer.extract(playlistId);
    assert.equal(result.complete, true);
    assert.equal(result.expectedCount, 131);
    assert.equal(result.tracks.length, 131);
    assert.deepEqual(result.tracks.map(track => track.position), Array.from({ length: 131 }, (_, index) => index + 1));
    assert.equal(result.tracks[0].title, result.tracks[100].title);
    assert.notEqual(result.tracks[0].spotifyId, result.tracks[100].spotifyId);
    assert.equal(result.tracks[130].durationMs, 181234);
    assert.deepEqual(result.tracks[130].artists, ['Fixture Artist']);
    assert.equal(result.verification.networkCount, 131);
    assert.deepEqual(result.verification.networkMismatches, []);
    assert.equal(result.verification.initialCookies, 0);
    assert.equal(fixture.stats.active, 0);
  } finally { await importer.close(); }
});

test('a 100-track truncation fails with all missing positions attached', async () => {
  const fixture = await fixtureBrowser(chromiumBrowser, { count: 131, available: 100 });
  const importer = await createPlaylistImporter({ browser: fixture.browser });
  try {
    await assert.rejects(importer.extract(playlistId), error => {
      assert.ok(error instanceof PlaylistImportError);
      assert.equal(error.code, 'INCOMPLETE');
      assert.equal(error.result.complete, false);
      assert.equal(error.result.tracks.length, 100);
      assert.deepEqual(error.result.missingPositions, Array.from({ length: 31 }, (_, index) => index + 101));
      return true;
    });
    assert.equal(fixture.stats.active, 0);
  } finally { await importer.close(); }
});

test('concurrent callers share a browser but respect the limit and isolate cookies', async () => {
  const fixture = await fixtureBrowser(chromiumBrowser, { count: 30 });
  const importer = await createPlaylistImporter({ browser: fixture.browser, concurrency: 2 });
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => importer.extract(playlistId)));
    assert.equal(fixture.stats.maximum, 2);
    assert.equal(fixture.stats.contexts, 4);
    assert.equal(fixture.stats.active, 0);
    assert.ok(results.every(result => result.complete && result.verification.initialCookies === 0));
  } finally { await importer.close(); }
  assert.equal(chromiumBrowser.isConnected(), true);
});

test('queued cancellation removes the job without creating a browser context', async () => {
  const fixture = await fixtureBrowser(chromiumBrowser, { count: 30 });
  const importer = await createPlaylistImporter({ browser: fixture.browser, concurrency: 1 });
  try {
    const first = importer.extract(playlistId);
    const controller = new AbortController();
    const queued = importer.extract(playlistId, { signal: controller.signal });
    controller.abort();
    await assert.rejects(queued, { code: 'ABORTED' });
    await first;
    assert.equal(fixture.stats.contexts, 1);
  } finally { await importer.close(); }
});

test('active cancellation and timeouts close their contexts', async () => {
  const fixture = await fixtureBrowser(chromiumBrowser, { slow: true });
  const importer = await createPlaylistImporter({ browser: fixture.browser });
  try {
    const controller = new AbortController();
    const task = importer.extract(playlistId, { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(task, { code: 'ABORTED' });
    await assert.rejects(importer.extract(playlistId, { timeoutMs: 200 }), { code: 'TIMEOUT' });
    assert.equal(fixture.stats.active, 0);
  } finally { await importer.close(); }
});

test('a queued deadline expires without taking another browser slot', async () => {
  const fixture = await fixtureBrowser(chromiumBrowser, { slow: true });
  const importer = await createPlaylistImporter({ browser: fixture.browser, concurrency: 1 });
  const active = importer.extract(playlistId);
  const settled = Promise.allSettled([active]);
  try {
    await assert.rejects(importer.extract(playlistId, { timeoutMs: 100 }), { code: 'TIMEOUT' });
    assert.equal(fixture.stats.contexts, 1);
  } finally {
    await importer.close();
    await settled;
  }
});

test('a playlist revision change is rejected even when every position is present', async () => {
  const fixture = await fixtureBrowser(chromiumBrowser, { count: 30, changeRevision: true });
  const importer = await createPlaylistImporter({ browser: fixture.browser });
  try {
    await assert.rejects(importer.extract(playlistId), error => {
      assert.equal(error.code, 'INCOMPLETE');
      assert.equal(error.result.tracks.length, 30);
      assert.deepEqual(error.result.missingPositions, []);
      assert.ok(error.result.verification.conflicts.includes('Playlist revision changed during extraction.'));
      return true;
    });
  } finally { await importer.close(); }
});

test('close cancels queued and active imports and rejects further work', async () => {
  const fixture = await fixtureBrowser(chromiumBrowser, { slow: true });
  const importer = await createPlaylistImporter({ browser: fixture.browser, concurrency: 1 });
  const tasks = [importer.extract(playlistId), importer.extract(playlistId)];
  const settled = Promise.allSettled(tasks);
  await importer.close();
  assert.ok((await settled).every(result => result.status === 'rejected' && result.reason.code === 'CLOSED'));
  await assert.rejects(importer.extract(playlistId), { code: 'CLOSED' });
  assert.equal(fixture.stats.active, 0);
});

test('unavailable playlists fail and release their context', async () => {
  const fixture = await fixtureBrowser(chromiumBrowser, { status: 404 });
  const importer = await createPlaylistImporter({ browser: fixture.browser });
  try {
    await assert.rejects(importer.extract(playlistId), { code: 'UNAVAILABLE' });
    assert.equal(fixture.stats.active, 0);
  } finally { await importer.close(); }
});

test('an empty playlist is a verified empty snapshot', async () => {
  const fixture = await fixtureBrowser(chromiumBrowser, { count: 0 });
  const importer = await createPlaylistImporter({ browser: fixture.browser });
  try {
    const result = await importer.extract(playlistId);
    assert.equal(result.complete, true);
    assert.deepEqual(result.tracks, []);
  } finally { await importer.close(); }
});
