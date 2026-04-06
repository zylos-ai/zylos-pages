(function() {
  const tabs = document.querySelectorAll('.index-tab');
  const panels = document.querySelectorAll('.tab-panel');
  if (!tabs.length) return;

  const params = new URLSearchParams(window.location.search);
  const initial = params.get('tab') || 'pages';

  function activate(name) {
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    panels.forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
    const url = new URL(window.location);
    if (name === 'pages') { url.searchParams.delete('tab'); } else { url.searchParams.set('tab', name); }
    history.replaceState(null, '', url);
  }

  activate(initial);
  tabs.forEach(t => t.addEventListener('click', () => activate(t.dataset.tab)));
})();
