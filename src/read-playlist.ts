import type { Page, Response } from 'playwright';
import { z } from 'zod';
import { PlaylistImportError } from './types.js';
import type { ImportOptions, PlaylistResult, PlaylistTrack } from './types.js';

const requestSchema = z.object({ variables: z.object({ uri: z.string() }) });
const responseSchema = z.object({ data: z.object({ playlistV2: z.object({
  revisionId: z.string().nullish(),
  content: z.object({
    totalCount: z.number().int().nonnegative(),
    pagingInfo: z.object({ offset: z.number().int().nonnegative() }),
    items: z.array(z.object({ itemV2: z.object({ data: z.object({
      name: z.string().optional(),
      uri: z.string().optional(),
      artists: z.object({ items: z.array(z.object({ profile: z.object({ name: z.string() }) })) }).optional(),
      trackDuration: z.object({ totalMilliseconds: z.number() }).optional(),
    }).nullish() }).nullish() })),
  }),
}) }) });

export async function readPlaylist(page: Page, id: string, onProgress?: ImportOptions['onProgress']): Promise<PlaylistResult> {
  const url = `https://open.spotify.com/playlist/${id}`;
  const network = new Map<number, PlaylistTrack>();
  const rows = new Map<number, PlaylistTrack>();
  const pending = new Set<Promise<void>>();
  const conflicts = new Set<string>();
  const revisions = new Set<string>();
  const batches: PlaylistResult['verification']['batches'] = [];
  const initialCookies = (await page.context().cookies()).length;

  function observe(response: Response) {
    if (new URL(response.url()).hostname !== 'api-partner.spotify.com'
      || !response.url().includes('/pathfinder/')) return;
    let body: unknown;
    try { body = response.request().postDataJSON(); } catch { return; }
    const request = requestSchema.safeParse(body);
    if (!request.success || request.data.variables.uri !== `spotify:playlist:${id}`) return;
    const job = (async () => {
      try {
        const payload: unknown = await response.json();
        const parsed = responseSchema.safeParse(payload);
        if (!parsed.success) return;
        const playlist = parsed.data.data.playlistV2;
        const content = playlist.content;
        if (playlist.revisionId) revisions.add(playlist.revisionId);
        batches.push({ offset: content.pagingInfo.offset, count: content.items.length, total: content.totalCount });
        content.items.forEach((item, index) => {
          const data = item.itemV2?.data;
          if (!data?.name) return;
          const position = content.pagingInfo.offset + index + 1;
          const track = {
            position,
            spotifyId: data.uri?.match(/^spotify:track:([A-Za-z0-9]{22})$/)?.[1] ?? null,
            title: data.name,
            artists: data.artists?.items.map(artist => artist.profile.name) ?? [],
            durationMs: data.trackDuration?.totalMilliseconds ?? null,
          };
          const prior = network.get(position);
          if (prior && prior.title !== track.title) conflicts.add(`Network position ${position} changed.`);
          network.set(position, track);
        });
      } catch {
        // DOM collection remains usable when optional network inspection fails.
      }
    })().finally(() => pending.delete(job));
    pending.add(job);
  }

  page.on('response', observe);
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (!response?.ok()) throw new PlaylistImportError('UNAVAILABLE', `Spotify returned HTTP ${response?.status() ?? 'unknown'}.`);
    try {
      await page.waitForFunction(() => /\b[\d,]+ songs?\b/.test(document.querySelector('main')?.innerText ?? ''), null, { timeout: 30_000 });
    } catch (cause) {
      throw new PlaylistImportError('UNAVAILABLE', 'Spotify did not display a playlist song count.', undefined, { cause });
    }
    const first = await readView(page, false);
    if (first.expected === null) throw new PlaylistImportError('PAGE_CHANGED', 'Playlist count could not be read.');
    const expected = first.expected;
    let previous = '';
    let stalled = 0;
    for (let step = 0; expected > 0 && step < Math.max(100, expected * 2); step++) {
      const view = await readView(page, true);
      if (view.expected !== expected) conflicts.add('Displayed playlist count changed.');
      if (view.gridTotal !== null && view.gridTotal !== expected) conflicts.add('Grid and displayed totals disagree.');
      for (const row of view.tracks) {
        if (row.position === null || !Number.isInteger(row.position) || row.position < 1 || !row.title) continue;
        if (row.displayedPosition !== row.position) {
          conflicts.add(`Position ${row.position} disagrees with its row index.`);
          continue;
        }
        const track: PlaylistTrack = {
          position: row.position, spotifyId: row.spotifyId, title: row.title,
          artists: row.artists, durationMs: row.durationMs,
        };
        const prior = rows.get(track.position);
        if (prior && (prior.title !== track.title || prior.spotifyId !== track.spotifyId)) {
          conflicts.add(`DOM position ${track.position} changed.`);
        }
        rows.set(track.position, track);
      }
      onProgress?.({ collected: rows.size, expected });
      if (rows.size === expected) break;
      const signature = `${view.top}:${view.totalHeight}:${rows.size}`;
      stalled = signature === previous ? stalled + 1 : 0;
      previous = signature;
      if (stalled >= 8) break;
      await page.waitForTimeout(view.bottom ? 1000 : 350);
    }
    // Detach before draining so late responses cannot mutate the final result.
    page.off('response', observe);
    await Promise.all(pending);
    const final = await readView(page, false);
    const tracks = [...rows.values()].sort((a, b) => a.position - b.position).map(track => {
      const data = network.get(track.position);
      return {
        ...track,
        artists: track.artists.length ? track.artists : data?.artists ?? [],
        durationMs: data?.durationMs ?? track.durationMs,
      };
    });
    const missingPositions = Array.from({ length: expected }, (_, index) => index + 1).filter(position => !rows.has(position));
    const mismatches = tracks.filter(track => {
      const data = network.get(track.position);
      return data && data.title !== track.title;
    }).map(track => track.position);
    if (revisions.size > 1) conflicts.add('Playlist revision changed during extraction.');
    if (batches.some(batch => batch.total !== expected)) conflicts.add('Network and displayed totals disagree.');
    return {
      id, url, title: first.title, importedAt: new Date().toISOString(), expectedCount: expected, tracks,
      complete: missingPositions.length === 0 && tracks.length === expected && final.expected === expected
        && conflicts.size === 0 && mismatches.length === 0 && tracks.every(track => track.position <= expected),
      missingPositions,
      verification: {
        initialCookies, finalDisplayedCount: final.expected, networkCount: network.size,
        networkMismatches: mismatches, conflicts: [...conflicts], revisions: [...revisions], batches,
      },
    };
  } finally {
    page.off('response', observe);
    await Promise.all(pending);
  }
}

async function readView(page: Page, advance: boolean) {
  return page.evaluate(shouldAdvance => {
    const main = document.querySelector('main');
    const count = main?.innerText.match(/\b([\d,]+) songs?\b/);
    const expected = count?.[1] ? Number(count[1].replaceAll(',', '')) : null;
    const first = main?.querySelector('[data-testid="tracklist-row"]');
    const grid = first?.closest('[role="grid"]');
    const tracks = [...(grid?.querySelectorAll('[data-testid="tracklist-row"]') ?? [])].map(row => {
      const index = row.closest('[aria-rowindex]')?.getAttribute('aria-rowindex');
      const link = row.querySelector('[data-testid="internal-track-link"]');
      const duration = row.querySelector('[role="gridcell"]:last-child')?.textContent?.match(/\b(?:(\d+):)?(\d+):(\d{2})\b/);
      return {
        position: index ? Number(index) - 1 : null,
        displayedPosition: Number(row.querySelector('[aria-colindex="1"] span')?.textContent),
        spotifyId: link?.getAttribute('href')?.match(/\/track\/([A-Za-z0-9]{22})/)?.[1] ?? null,
        title: link?.textContent ?? null,
        artists: [...row.querySelectorAll('[aria-colindex="2"] a[href*="/artist/"]')].map(artist => artist.textContent ?? '').filter(Boolean),
        durationMs: duration ? (Number(duration[1] ?? 0) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000 : null,
      };
    });
    let scroll = grid?.parentElement ?? null;
    while (scroll && !(scroll.scrollHeight > scroll.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(scroll).overflowY))) {
      scroll = scroll.parentElement;
    }
    const top = scroll?.scrollTop ?? 0;
    const totalHeight = scroll?.scrollHeight ?? 0;
    const bottom = !scroll || top + scroll.clientHeight >= totalHeight - 2;
    if (shouldAdvance && scroll) scroll.scrollTop += Math.max(1, Math.floor(scroll.clientHeight * 0.7));
    return {
      title: main?.querySelector('h1')?.textContent ?? '', expected, tracks,
      gridTotal: grid?.hasAttribute('aria-rowcount') ? Number(grid.getAttribute('aria-rowcount')) - 1 : null,
      top, totalHeight, bottom,
    };
  }, advance);
}
