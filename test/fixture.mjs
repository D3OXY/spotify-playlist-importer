export const playlistId = '2gWVzPkdkpeGfMdcAkTBLv';

export async function fixtureBrowser(browser, options = {}) {
  const stats = { active: 0, maximum: 0, contexts: 0 };
  const shared = {
    async newContext(settings) {
      const context = await browser.newContext(settings);
      stats.contexts++;
      stats.active++;
      stats.maximum = Math.max(stats.maximum, stats.active);
      context.once('close', () => stats.active--);
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname === 'api-partner.spotify.com') {
          if (route.request().method() === 'OPTIONS') {
            await route.fulfill({ status: 204, headers: {
              'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST',
              'Access-Control-Allow-Headers': 'Content-Type',
            } });
            return;
          }
          const offset = route.request().postDataJSON().variables.offset;
          const count = Math.min(offset === 0 ? 25 : 50, (options.available ?? options.count ?? 131) - offset);
          await route.fulfill({ json: { data: { playlistV2: {
            revisionId: options.changeRevision && offset > 0 ? 'changed-revision' : 'fixture-revision',
            content: {
              totalCount: options.count ?? 131, pagingInfo: { offset },
              items: Array.from({ length: Math.max(0, count) }, (_, index) => ({ itemV2: { data: {
                name: title(offset + index + 1), uri: `spotify:track:${trackId(offset + index + 1)}`,
                artists: { items: [{ profile: { name: 'Fixture Artist' } }] },
                trackDuration: { totalMilliseconds: 181234 },
              } } })),
            },
          } } }, headers: { 'Access-Control-Allow-Origin': '*' } });
        } else if (url.hostname === 'open.spotify.com' && url.pathname === `/playlist/${playlistId}`) {
          await route.fulfill({ status: options.status ?? 200, contentType: 'text/html', body: fixtureHtml(options) });
        } else await route.abort();
      });
      return context;
    },
  };
  return { browser: shared, stats };
}

function fixtureHtml(options) {
  return `<!doctype html><html><body><main><h1>Fixture playlist</h1>
    <p>${options.count ?? 131} songs</p>
    <div id="scroll" style="height:450px;overflow-y:auto">
      <div role="grid" aria-rowcount="${(options.count ?? 131) + 1}" style="position:relative;height:${(options.count ?? 131) * 56}px"></div>
    </div></main><script>
    const count = ${options.count ?? 131};
    const available = ${options.available ?? options.count ?? 131};
    const slow = ${options.slow ?? false};
    const scroll = document.getElementById('scroll');
    const grid = document.querySelector('[role=grid]');
    const makeTitle = ${title.toString()};
    const makeId = ${trackId.toString()};
    let loaded = 0, loading = false;
    async function load() {
      if (loading || loaded >= available || slow) return;
      loading = true;
      const offset = loaded;
      const response = await fetch('https://api-partner.spotify.com/pathfinder/v2/query', {
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({variables:{uri:'spotify:playlist:${playlistId}',offset}})
      });
      const body=await response.json();
      await new Promise(resolve=>setTimeout(resolve,60));
      loaded += body.data.playlistV2.content.items.length;
      loading = false; render();
    }
    function render() {
      const start = Math.max(1,Math.floor(scroll.scrollTop/56)-6);
      const end = Math.min(available,Math.ceil((scroll.scrollTop+450)/56)+14);
      grid.innerHTML = '';
      for(let position=start;position<=Math.min(loaded,end);position++) {
        const row = document.createElement('div');
        row.setAttribute('role','row'); row.setAttribute('aria-rowindex',position+1);
        row.style.cssText='position:absolute;height:56px;top:'+((position-1)*56)+'px';
        row.innerHTML='<div data-testid="tracklist-row"><div role="gridcell" aria-colindex="1"><span>'+position+'</span></div><div role="gridcell" aria-colindex="2"><a data-testid="internal-track-link" href="/track/'+makeId(position)+'">'+makeTitle(position)+'</a><a href="/artist/fixture">Fixture Artist</a></div><div role="gridcell" aria-colindex="3">3:01</div></div>';
        grid.append(row);
      }
      if (end>loaded-10) void load();
    }
    scroll.addEventListener('scroll',render);
    document.cookie = 'fixture=present';
    render();
    </script></body></html>`;
}

function title(position) {
  return position === 1 || position === 101 ? 'Repeated title' : `Song ${position}`;
}

function trackId(position) {
  return String(position).padStart(22, '0');
}
