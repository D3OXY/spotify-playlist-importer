export function parsePlaylistId(input: string): string {
  if (/^[A-Za-z0-9]{22}$/.test(input)) return input;
  const uri = /^spotify:playlist:([A-Za-z0-9]{22})$/.exec(input);
  if (uri?.[1]) return uri[1];
  try {
    const url = new URL(input);
    const match = /^\/playlist\/([A-Za-z0-9]{22})\/?$/.exec(url.pathname);
    if (url.protocol === 'https:' && url.hostname === 'open.spotify.com'
      && !url.port && !url.username && !url.password && match?.[1]) return match[1];
  } catch {
    // Inputs may be IDs or Spotify URIs rather than URLs.
  }
  throw new TypeError('Expected a Spotify playlist ID, spotify:playlist URI, or https://open.spotify.com/playlist URL.');
}
