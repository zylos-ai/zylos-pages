import fs from 'node:fs';
import path from 'node:path';

export const MINIMUM_COOKIE_FILTER_CORE_VERSION = '0.8.2';

function versionParts(value) {
  const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : null;
}

export function coreSupportsCookieAllowlist(home = process.env.HOME) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(home, 'zylos/package.json'), 'utf8'));
    const current = versionParts(pkg.version);
    const minimum = versionParts(MINIMUM_COOKIE_FILTER_CORE_VERSION);
    if (!current || !minimum) return { supported: false, version: pkg.version || null };
    for (let i = 0; i < minimum.length; i++) {
      if (current[i] !== minimum[i]) {
        return { supported: current[i] > minimum[i], version: pkg.version };
      }
    }
    return { supported: true, version: pkg.version };
  } catch {
    return { supported: false, version: null };
  }
}

export function warnIfCoreCookieAllowlistUnavailable(home, warn = console.warn) {
  const result = coreSupportsCookieAllowlist(home);
  if (!result.supported) {
    warn(`zylos-core >=${MINIMUM_COOKIE_FILTER_CORE_VERSION} is required to enforce the Pages route Cookie allowlist; installed version: ${result.version || 'unknown'}.`);
  }
  return result;
}
