(() => {
  const iframe = document.querySelector('.html-artifact-frame[data-bridge-endpoint]');
  if (!iframe) return;

  const endpoint = iframe.dataset.bridgeEndpoint;
  const maxPending = 16;
  const maxConcurrent = 4;
  let generation = 0;
  let port = null;
  let active = 0;
  const queue = [];

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
    closePort();
    iframe.contentWindow.postMessage({ type: 'zylos-pages:bridge-probe' }, '*');
  });
  window.addEventListener('message', event => {
    if (event.source !== iframe.contentWindow || event.data?.type !== 'zylos-pages:bridge-ready') return;
    closePort();
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
})();
