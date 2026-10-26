import type { Browser, LaunchOptions } from 'playwright';

export interface PlaylistTrack {
  position: number;
  spotifyId: string | null;
  title: string;
  artists: string[];
  durationMs: number | null;
}

export interface PlaylistResult {
  id: string;
  url: string;
  title: string;
  importedAt: string;
  expectedCount: number;
  tracks: PlaylistTrack[];
  complete: boolean;
  missingPositions: number[];
  verification: {
    initialCookies: number;
    finalDisplayedCount: number | null;
    networkCount: number;
    networkMismatches: number[];
    conflicts: string[];
    revisions: string[];
    batches: { offset: number; count: number; total: number }[];
  };
}

export interface ImportOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (progress: { collected: number; expected: number }) => void;
}

export interface ImporterOptions {
  concurrency?: number;
  timeoutMs?: number;
  browser?: Browser;
  launchOptions?: LaunchOptions;
}

export interface PlaylistImporter {
  extract(input: string, options?: ImportOptions): Promise<PlaylistResult>;
  close(): Promise<void>;
}

export type ImportErrorCode = 'INCOMPLETE' | 'ABORTED' | 'TIMEOUT' | 'CLOSED' | 'UNAVAILABLE' | 'PAGE_CHANGED';

export class PlaylistImportError extends Error {
  constructor(
    public readonly code: ImportErrorCode,
    message: string,
    public readonly result?: PlaylistResult,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PlaylistImportError';
  }
}
