(function() {
  const rootBase = window.__PAGES_BASE || '';

  function apiPath(path) {
    return `${rootBase}${path}`;
  }

  function createElement(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === false || value === null || value === undefined) continue;
      if (key === 'className') node.className = value;
      else if (key === 'textContent') node.textContent = value;
      else if (key === 'type') node.type = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) node.append(child);
    return node;
  }

  function injectStyles() {
    if (document.getElementById('pages-attachments-style')) return;
    const style = document.createElement('style');
    style.id = 'pages-attachments-style';
    style.textContent = `
      .pages-attachments { display: grid; gap: 10px; margin-top: 10px; }
      .pages-attachments__toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .pages-attachments__input { max-width: 100%; }
      .pages-attachments__status { min-height: 18px; font-size: 13px; color: #555; }
      .pages-attachments__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(88px, 1fr)); gap: 8px; }
      .pages-attachments__item { position: relative; display: grid; gap: 4px; min-width: 0; }
      .pages-attachments__thumb { width: 100%; aspect-ratio: 1; object-fit: cover; border: 1px solid #d8d8d8; background: #f6f6f6; cursor: zoom-in; }
      .pages-attachments__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: #555; }
      .pages-attachments__delete { position: absolute; top: 4px; right: 4px; width: 26px; height: 26px; border: 0; border-radius: 4px; background: rgba(0,0,0,.72); color: white; cursor: pointer; line-height: 1; }
      .pages-attachments__preview { border: 0; padding: 0; background: transparent; max-width: min(92vw, 960px); }
      .pages-attachments__preview::backdrop { background: rgba(0,0,0,.7); }
      .pages-attachments__preview img { display: block; max-width: min(92vw, 960px); max-height: 86vh; }
    `;
    document.head.append(style);
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `Request failed (${response.status})`);
    }
    return payload;
  }

  function isShareView() {
    return window.__PAGES_VIEWER === 'share'
      || document.documentElement.dataset.viewer === 'share'
      || document.body.dataset.viewer === 'share';
  }

  function canEditAttachments() {
    if (!isShareView()) return true;
    return window.__PAGES_SHARE_EDITABLE === true;
  }

  function attachmentUrl(fileUrl) {
    if (!fileUrl) return '';
    if (fileUrl.startsWith('http://') || fileUrl.startsWith('https://')) return fileUrl;
    if (rootBase && fileUrl.startsWith(`${rootBase}/`)) return fileUrl;
    if (fileUrl.startsWith('/')) return `${rootBase}${fileUrl}`;
    return apiPath(`/${fileUrl}`);
  }

  function setupContainer(container) {
    const artifact = container.dataset.artifact || 'renovation-checklist';
    const itemKey = container.dataset.itemKey || 'photo-log';
    const readOnly = !canEditAttachments() || container.dataset.readonly === 'true';
    container.classList.add('pages-attachments');

    const status = createElement('div', {
      className: 'pages-attachments__status',
      role: 'status',
      'aria-live': 'polite',
    });
    const grid = createElement('div', { className: 'pages-attachments__grid' });
    const preview = createElement('dialog', { className: 'pages-attachments__preview' });
    preview.addEventListener('click', () => preview.close());
    document.body.append(preview);

    async function load() {
      status.textContent = '';
      const payload = await requestJson(apiPath(`/api/attachments/${encodeURIComponent(artifact)}/${encodeURIComponent(itemKey)}`));
      grid.replaceChildren();
      for (const attachment of payload.attachments || []) {
        const img = createElement('img', {
          className: 'pages-attachments__thumb',
          src: attachmentUrl(attachment.fileUrl),
          alt: attachment.originalFilename || 'Attachment',
          loading: 'lazy',
        });
        img.addEventListener('click', () => {
          preview.replaceChildren(createElement('img', {
            src: attachmentUrl(attachment.fileUrl),
            alt: attachment.originalFilename || 'Attachment',
          }));
          preview.showModal();
        });
        const itemChildren = [
          img,
          createElement('div', {
            className: 'pages-attachments__name',
            textContent: attachment.originalFilename || attachment.attachmentId,
            title: attachment.originalFilename || attachment.attachmentId,
          }),
        ];
        if (!readOnly) {
          const remove = createElement('button', {
            className: 'pages-attachments__delete',
            type: 'button',
            title: 'Delete photo',
            'aria-label': 'Delete photo',
            textContent: 'x',
          });
          remove.addEventListener('click', async () => {
            remove.disabled = true;
            try {
              await requestJson(apiPath(`/api/attachments/${encodeURIComponent(artifact)}/${attachment.attachmentId}`), {
                method: 'DELETE',
                headers: { 'Accept': 'application/json' },
              });
              await load();
            } catch (err) {
              status.textContent = err.message;
              remove.disabled = false;
            }
          });
          itemChildren.push(remove);
        }
        grid.append(createElement('div', { className: 'pages-attachments__item' }, itemChildren));
      }
    }

    if (!readOnly) {
      const input = createElement('input', {
        className: 'pages-attachments__input',
        type: 'file',
        accept: 'image/jpeg,image/png,image/webp',
      });
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const body = new FormData();
        body.append('file', file);
        input.disabled = true;
        status.textContent = 'Uploading...';
        try {
          await requestJson(apiPath(`/api/attachments/${encodeURIComponent(artifact)}/${encodeURIComponent(itemKey)}`), {
            method: 'POST',
            body,
          });
          input.value = '';
          await load();
        } catch (err) {
          status.textContent = err.message;
        } finally {
          input.disabled = false;
        }
      });
      container.append(createElement('div', { className: 'pages-attachments__toolbar' }, [input]));
    }

    container.append(status, grid);
    load().catch((err) => {
      status.textContent = err.message;
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    injectStyles();
    document.querySelectorAll('[data-pages-attachments]').forEach(setupContainer);
  });
})();
