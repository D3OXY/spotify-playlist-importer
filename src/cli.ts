#!/usr/bin/env node
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createPlaylistImporter, parsePlaylistId, PlaylistImportError } from './importer.js';
import type { PlaylistResult } from './types.js';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { out: { type: 'string' }, timeout: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help || positionals.length !== 1) {
    console.log('Usage: spotify-playlist-importer <playlist URL, URI, or ID> [--out directory] [--timeout milliseconds]');
    if (!values.help) process.exitCode = 1;
    return;
  }
  const input = positionals[0];
  if (!input) return;
  const id = parsePlaylistId(input);
  const output = resolve(values.out ?? `output/${id}`);
  const importer = await createPlaylistImporter(values.timeout ? { timeoutMs: Number(values.timeout) } : {});
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const result = await importer.extract(input, {
      signal: controller.signal,
      onProgress: ({ collected, expected }) => console.error(`${collected}/${expected} tracks`),
    });
    await save(result, output);
    console.log(JSON.stringify({ complete: true, extracted: result.tracks.length, expected: result.expectedCount, output }));
  } catch (error) {
    if (error instanceof PlaylistImportError && error.result) await save(error.result, output);
    throw error;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    await importer.close();
  }
}

async function save(result: PlaylistResult, directory: string) {
  await mkdir(directory, { recursive: true });
  const suffix = result.complete ? '' : '.partial';
  const titles = result.tracks.map(track => track.title.replace(/[\r\n]+/g, ' ')).join('\n') + (result.tracks.length ? '\n' : '');
  for (const { name, body } of [
    { name: `songs${suffix}.txt`, body: titles },
    { name: `playlist${suffix}.json`, body: JSON.stringify(result, null, 2) + '\n' },
  ]) {
    const file = resolve(directory, name);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, file);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof PlaylistImportError
    ? error.code === 'INCOMPLETE' ? 2 : error.code === 'ABORTED' ? 130 : error.code === 'TIMEOUT' ? 124 : 1
    : 1;
});
