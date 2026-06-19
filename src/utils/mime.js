// Static asset MIME map for files served from the pages content directory.

const MIME_TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.pdf', 'application/pdf'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.eot', 'application/vnd.ms-fontobject'],
]);

export function isAssetExtension(extension) {
  return MIME_TYPES.has(String(extension || '').toLowerCase());
}

export function getMimeType(extension) {
  return MIME_TYPES.get(String(extension || '').toLowerCase()) || null;
}
