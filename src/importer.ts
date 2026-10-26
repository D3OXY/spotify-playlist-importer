import { chromium } from 'playwright';
import { parsePlaylistId } from './playlist-id.js';
import { readPlaylist } from './read-playlist.js';
import { PlaylistImportError } from './types.js';
import type { ImporterOptions, ImportOptions, PlaylistImporter, PlaylistResult } from './types.js';

export { parsePlaylistId, PlaylistImportError };
export type { ImporterOptions, ImportOptions, PlaylistImporter, PlaylistResult, PlaylistTrack, ImportErrorCode } from './types.js';

/** Reuse one Chromium process, with a fresh context for every queued import. */
export async function createPlaylistImporter(options: ImporterOptions = {}): Promise<PlaylistImporter> {
  const concurrency = options.concurrency ?? 2;
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency must be a positive integer.');
  checkTimeout(timeoutMs);
  const browser = options.browser ?? await chromium.launch({ headless: true, ...options.launchOptions });
  const stop = new AbortController();
  const queue: { start: () => void; cancel: () => void }[] = [];
  const running = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;

  function drain() {
    while (!stop.signal.aborted && running.size < concurrency && queue.length) queue.shift()?.start();
  }

  function extract(input: string, request: ImportOptions = {}): Promise<PlaylistResult> {
    if (stop.signal.aborted) return Promise.reject(new PlaylistImportError('CLOSED', 'Importer is closed.'));
    const id = parsePlaylistId(input);
    const duration = request.timeoutMs ?? timeoutMs;
    checkTimeout(duration);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), duration);
    const signal = AbortSignal.any([stop.signal, deadline.signal, ...(request.signal ? [request.signal] : [])]);
    const abortError = () => stop.signal.aborted
      ? new PlaylistImportError('CLOSED', 'Importer is closed.')
      : request.signal?.aborted
        ? new PlaylistImportError('ABORTED', 'Playlist import was cancelled.')
        : new PlaylistImportError('TIMEOUT', `Playlist import exceeded ${duration} ms, including queue time.`);

    return new Promise<PlaylistResult>((resolve, reject) => {
      const job = {
        cancel() {
          const index = queue.indexOf(job);
          if (index !== -1) queue.splice(index, 1);
          signal.removeEventListener('abort', job.cancel);
          clearTimeout(timer);
          reject(abortError());
        },
        start() {
          signal.removeEventListener('abort', job.cancel);
          const task = run().then(resolve, reject).finally(() => {
            clearTimeout(timer);
            running.delete(task);
            drain();
          });
          running.add(task);
        },
      };

      async function run() {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' });
        let contextClosing: Promise<void> | undefined;
        const closeContext = () => contextClosing ??= context.close();
        const abort = () => { void closeContext().catch(() => {}); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          if (signal.aborted) throw abortError();
          const page = await context.newPage();
          const result = await readPlaylist(page, id, request.onProgress);
          if (signal.aborted) throw abortError();
          if (!result.complete) {
            throw new PlaylistImportError('INCOMPLETE', `Retrieved ${result.tracks.length}/${result.expectedCount} tracks.`, result);
          }
          return result;
        } catch (error) {
          if (signal.aborted) throw abortError();
          throw error;
        } finally {
          signal.removeEventListener('abort', abort);
          await closeContext();
        }
      }

      if (signal.aborted) job.cancel();
      else {
        queue.push(job);
        signal.addEventListener('abort', job.cancel, { once: true });
        drain();
      }
    });
  }

  function close(): Promise<void> {
    if (!closing) {
      stop.abort();
      closing = (async () => {
        await Promise.allSettled([...running]);
        if (!options.browser) await browser.close();
      })();
    }
    return closing;
  }

  return { extract, close };
}

function checkTimeout(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new RangeError('timeoutMs must be an integer between 1 and 2147483647.');
  }
}
