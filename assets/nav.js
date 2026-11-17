(function(){
  var toggle = document.querySelector('.nav-toggle');
  var sidebar = document.querySelector('.nav-sidebar');
  var overlay = document.querySelector('.nav-overlay');
  if (!toggle || !sidebar) return;
  function open() { sidebar.classList.add('open'); overlay.hidden = false; }
  function close() { sidebar.classList.remove('open'); overlay.hidden = true; }
  toggle.addEventListener('click', function(){ sidebar.classList.contains('open') ? close() : open(); });
  overlay.addEventListener('click', close);
})();

// Owner navigation fetches direct children only; closed folders have no rows.
(function () {
  const sidebar = document.querySelector('.nav-sidebar[data-current-uri]');
  if (!sidebar) return;
  const base = sidebar.dataset.baseUrl || '';
  const current = sidebar.dataset.currentUri;
  const root = sidebar.querySelector('.page-nav-list');
  const form = sidebar.querySelector('.nav-search');
  let viewGeneration = 0;

  function listState(list, folder, query = '', countNode = null) {
    return { list, folder, query, countNode, generation: viewGeneration, entries: new Map(), offset: 0, loaded: false, pending: null, button: null };
  }
  function pageItem(state, item) {
    const key = `page:${item.uri}`;
    if (state.entries.has(key)) return;
    const li = document.createElement('li');
    if (item.uri === current) li.className = 'active';
    const a = document.createElement('a');
    a.href = item.url;
    a.textContent = item.title || item.uri;
    li.append(a); state.list.insertBefore(li, state.button); state.entries.set(key, li);
  }
  function folderItem(state, item) {
    const key = `folder:${item.path}`;
    if (state.entries.has(key)) {
      const entry = state.entries.get(key);
      if (item.count !== undefined) entry.count.textContent = item.count;
      return entry;
    }
    const li = document.createElement('li'); li.className = 'nav-folder';
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const name = document.createElement('span'); name.className = 'nav-folder-name'; name.textContent = item.name;
    const count = document.createElement('span'); count.className = 'nav-folder-count'; count.textContent = item.count ?? '';
    const ul = document.createElement('ul'); ul.className = 'nav-folder-list';
    summary.append(name, count); details.append(summary, ul); li.append(details); state.list.insertBefore(li, state.button);
    const child = listState(ul, item.path, '', count);
    const entry = { details, child, count };
    state.entries.set(key, entry);
    details.addEventListener('toggle', () => { if (details.open && !child.loaded) load(child); });
    return entry;
  }
  async function load(state) {
    if (state.pending) return state.pending;
    state.button?.remove(); state.button = null;
    state.pending = (async () => {
      try {
        const params = new URLSearchParams({ folder: state.folder, offset: state.offset, limit: 50 });
        if (state.query) params.set('q', state.query);
        const res = await fetch(`${base}/api/pages?${params}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('Could not load pages');
        const data = await res.json();
        if (state.generation !== viewGeneration) return;
        sidebar.querySelector('.nav-total').textContent = `(${data.total})`;
        if (state.countNode) state.countNode.textContent = data.folderTotal;
        for (const item of data.items) {
          if (item.kind === 'folder') folderItem(state, item);
          else pageItem(state, item);
        }
        state.loaded = true; state.offset = data.nextOffset;
        if (state.offset === null) return;
        addMore(state, 'Load more');
      } catch {
        if (state.generation === viewGeneration) addMore(state, 'Retry loading pages');
      } finally { state.pending = null; }
    })();
    return state.pending;
  }
  function addMore(state, label) {
    const li = document.createElement('li');
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.className = 'nav-load-more'; button.addEventListener('click', () => load(state));
    li.append(button); state.list.append(li); state.button = li;
  }
  async function revealCurrent(state) {
    const segments = current.split('/');
    for (let i = 0; i < segments.length - 1; i++) {
      const folder = segments.slice(0, i + 1).join('/');
      if (state.generation !== viewGeneration) return;
      const entry = folderItem(state, { path: folder, name: segments[i] });
      entry.details.open = true;
      await load(entry.child);
      state = entry.child;
    }
    // Keep the current page visible even if its siblings span many batches.
    if (state.generation !== viewGeneration) return;
    pageItem(state, { uri: current, title: sidebar.dataset.currentTitle, url: `${base}/p/${encodeURI(current)}` });
  }
  const initial = listState(root, '');
  load(initial).then(() => revealCurrent(initial));
  form.addEventListener('submit', event => {
    event.preventDefault(); viewGeneration += 1; root.replaceChildren();
    const query = form.querySelector('input').value.trim();
    const state = listState(root, '', query);
    load(state).then(() => { if (!query) revealCurrent(state); });
  });
})();
