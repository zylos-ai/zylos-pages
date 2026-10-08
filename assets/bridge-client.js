(() => {
  if (window.zylosPages) return;
  let port = null;
  let sequence = 0;
  let readyTimer = null;
  const pending = new Map();

  const request = (operation, input = {}) => new Promise((resolve, reject) => {
    if (!port) return reject(Object.assign(new Error('bridge unavailable'), { code: 'bridge_unavailable' }));
    const id = `${Date.now().toString(36)}-${(++sequence).toString(36)}`;
    pending.set(id, { resolve, reject });
    port.postMessage({ id, operation, input });
  });

  window.addEventListener('message', event => {
    if (event.source !== parent) return;
    if (event.data?.type === 'zylos-pages:bridge-probe') {
      announceReady();
      return;
    }
    if (event.data?.type !== 'zylos-pages:bridge-port' || event.ports.length !== 1) return;
    port?.close();
    for (const waiter of pending.values()) waiter.reject(Object.assign(new Error('bridge port expired'), { code: 'port_expired' }));
    pending.clear();
    if (readyTimer) clearInterval(readyTimer);
    port = event.ports[0];
    port.onmessage = message => {
      const response = message.data;
      const waiter = pending.get(response?.id);
      if (!waiter) return;
      pending.delete(response.id);
      if (response.ok) waiter.resolve(response.result);
      else waiter.reject(Object.assign(new Error(response.error?.message || 'bridge request failed'), { code: response.error?.code || 'bridge_error' }));
    };
    port.start();
    window.dispatchEvent(new CustomEvent('zylos-pages:bridge-ready'));
  });

  window.zylosPages = Object.freeze({ request });
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor || anchor.hasAttribute('download')) return;
    const rawHref = anchor.getAttribute('href');
    if (!rawHref || rawHref.startsWith('#')) return;
    event.preventDefault();
    request('page.open', { href: rawHref }).catch(error => {
      console.warn('[zylos-pages] page.open rejected', error?.code || 'bridge_error');
    });
  });
  const announceReady = () => parent.postMessage({ type: 'zylos-pages:bridge-ready' }, '*');
  announceReady();
  readyTimer = setInterval(announceReady, 250);
  setTimeout(() => { if (readyTimer) clearInterval(readyTimer); }, 5000);
})();
