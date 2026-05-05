// Browser-visible base path helpers for stripped reverse-proxy deployments.

function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0];
  if (typeof value !== 'string') return '';
  return value.split(',')[0].trim();
}

function isSafePathPrefix(prefix) {
  if (!prefix || prefix === '/') return true;
  if (!prefix.startsWith('/')) return false;
  if (prefix.includes('\\') || prefix.includes('://') || /[\x00-\x20?#"'`<>&%]/.test(prefix)) return false;
  try {
    const decoded = decodeURIComponent(prefix);
    if (/[\x00-\x20?#\\"'`<>&]/.test(decoded)) return false;
    return decoded.split('/').every(part => part !== '..' && part !== '.');
  } catch {
    return false;
  }
}

export function browserBaseFromRequest(req, fallback = '') {
  const prefix = firstHeaderValue(req.headers['x-forwarded-prefix']);
  if (!prefix) return fallback;
  if (!isSafePathPrefix(prefix)) return fallback;
  if (prefix === '/') return '';
  return prefix.replace(/\/+$/, '') || '';
}

export function browserRoot(baseUrl) {
  return `${baseUrl || ''}/`;
}

export function browserPath(baseUrl, path) {
  const cleanPath = String(path).replace(/^\/+/, '');
  return `${baseUrl || ''}/${cleanPath}`;
}

export function isPathWithinBase(path, baseUrl) {
  if (!path || typeof path !== 'string') return false;
  if (!path.startsWith('/') || path.startsWith('//')) return false;
  if (path.includes('\\') || path.includes('://') || /[\x00-\x1f]/.test(path)) return false;
  const pathname = path.split(/[?#]/, 1)[0];
  try {
    const decoded = decodeURIComponent(pathname);
    if (decoded.split('/').some(part => part === '..' || part === '.')) return false;
  } catch {
    return false;
  }
  if (!baseUrl) return true;
  return path === baseUrl || path.startsWith(`${baseUrl}/`);
}
