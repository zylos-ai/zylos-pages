(() => {
  const iframe = document.querySelector('.html-artifact-frame[data-bridge-endpoint]');
  if (!iframe) return;

  const endpoint = iframe.dataset.bridgeEndpoint;
  const expectedSrc = iframe.dataset.bridgeSrc;
  if (!expectedSrc) return;
  const hasQueryDelimiter = url => {
    const hrefWithoutHash = url.hash ? url.href.slice(0, -url.hash.length) : url.href;
    return hrefWithoutHash.includes('?');
  };
  let pageOpenPaths;
  try {
    const configuredPaths = JSON.parse(iframe.dataset.pageOpenPaths || '[]');
    if (!Array.isArray(configuredPaths) || configuredPaths.some(path => typeof path !== 'string')) return;
    pageOpenPaths = new Set(configuredPaths.map(path => {
      const configured = new URL(path, window.location.href);
      if (configured.origin !== window.location.origin || hasQueryDelimiter(configured) || configured.hash) throw new Error('invalid page path');
      return configured.pathname;
    }));
  } catch {
    return;
  }
  const outboundDenied = iframe.dataset.outboundDenied === 'true';
  const maxPending = 16;
  const maxConcurrent = 4;
  let generation = 0;
  let port = null;
  let active = 0;
  let initialLoadComplete = false;
  let provisioned = false;
  let revoked = false;
  const queue = [];

  const bridgeError = (code, message) => ({ ok: false, error: { code, message } });

  const openPage = input => {
    if (!input || Object.keys(input).length !== 1 || typeof input.href !== 'string') {
      return bridgeError('invalid_request', 'page.open requires only a string href');
    }
    if (navigator.userActivation?.isActive !== true) {
      return bridgeError('user_activation_required', 'page.open requires active user interaction');
    }
    let target;
    try {
      target = new URL(input.href, window.location.href);
    } catch {
      return bridgeError('invalid_url', 'page.open href must be a valid URL');
    }
    if (!['http:', 'https:'].includes(target.protocol)) {
      return bridgeError('unsupported_scheme', 'page.open allows only HTTP(S) URLs');
    }
    if (target.username || target.password) {
      return bridgeError('navigation_denied', 'page.open does not allow URL credentials');
    }
    if (target.origin === window.location.origin) {
      if (hasQueryDelimiter(target) || !pageOpenPaths.has(target.pathname)) {
        return bridgeError('navigation_denied', 'same-site target is not a registered page view');
      }
      window.location.assign(target.href);
      return { ok: true, result: { ok: true } };
    }
    if (outboundDenied) {
      return bridgeError('outbound_denied', 'external navigation is disabled for this page');
    }
    window.open(target.href, '_blank', 'noopener,noreferrer');
    return { ok: true, result: { ok: true } };
  };

  const closePort = () => {
    queue.splice(0).forEach(item => item.reply({ ok: false, error: { code: 'port_expired', message: 'bridge port expired' } }));
    generation += 1;
    port?.close();
    port = null;
    active = 0;
  };

  const pump = () => {
    while (port && active < maxConcurrent && queue.length > 0) {
      const item = queue.shift();
      active += 1;
      fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: item.operation, input: item.input }),
      }).then(async response => {
        const body = await response.json().catch(() => ({ ok: false, error: { code: 'invalid_response', message: 'invalid bridge response' } }));
        item.reply(body);
      }).catch(() => item.reply({ ok: false, error: { code: 'network_error', message: 'bridge request failed' } }))
        .finally(() => {
          if (generation !== item.generation) return;
          active -= 1;
          pump();
        });
    }
  };

  iframe.addEventListener('load', () => {
    if (!initialLoadComplete) {
      initialLoadComplete = true;
      iframe.contentWindow.postMessage({ type: 'zylos-pages:bridge-probe' }, '*');
      return;
    }
    revoked = true;
    closePort();
  });
  window.addEventListener('message', event => {
    if (event.source !== iframe.contentWindow || event.data?.type !== 'zylos-pages:bridge-ready') return;
    if (!initialLoadComplete || provisioned || revoked) return;
    provisioned = true;
    const channel = new MessageChannel();
    const currentGeneration = generation;
    port = channel.port1;
    port.onmessage = message => {
      const request = message.data;
      const reply = body => {
        if (port && generation === currentGeneration) port.postMessage({ id: request?.id ?? null, ...body });
      };
      if (!request || typeof request.id !== 'string' || typeof request.operation !== 'string' || !request.input || typeof request.input !== 'object' || Array.isArray(request.input)) {
        reply({ ok: false, error: { code: 'invalid_request', message: 'invalid bridge request' } });
        return;
      }
      if (request.operation === 'page.open') {
        reply(openPage(request.input));
        return;
      }
      if (queue.length + active >= maxPending) {
        reply({ ok: false, error: { code: 'too_many_pending', message: 'too many pending bridge requests' } });
        return;
      }
      queue.push({ operation: request.operation, input: request.input, reply, generation: currentGeneration });
      pump();
    };
    port.start();
    iframe.contentWindow.postMessage({ type: 'zylos-pages:bridge-port' }, '*', [channel.port2]);
  });
  iframe.src = expectedSrc;
})();
