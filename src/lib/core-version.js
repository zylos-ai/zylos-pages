import fs from 'node:fs';
import path from 'node:path';

export const MINIMUM_COOKIE_FILTER_CORE_VERSION = '0.8.2';

function versionParts(value) {
  const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : null;
}

function findExecutable(name, pathValue = process.env.PATH || '') {
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Keep searching PATH.
    }
  }
  return null;
}

function packageForExecutable(executable) {
  let directory = path.dirname(executable);
  while (true) {
    const candidate = path.join(directory, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (pkg.name === 'zylos') return pkg;
    } catch {
      // This ancestor is not the installed zylos package root.
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export function coreSupportsCookieAllowlist({ pathValue = process.env.PATH || '' } = {}) {
  try {
    const executable = findExecutable('zylos', pathValue);
    if (!executable) return { supported: false, version: null, state: 'missing' };
    const pkg = packageForExecutable(executable);
    if (!pkg) return { supported: false, version: null, state: 'invalid' };
    const current = versionParts(pkg.version);
    const minimum = versionParts(MINIMUM_COOKIE_FILTER_CORE_VERSION);
    if (!current || !minimum) return { supported: false, version: pkg.version || null, state: 'invalid' };
    for (let i = 0; i < minimum.length; i++) {
      if (current[i] !== minimum[i]) {
        const supported = current[i] > minimum[i];
        return { supported, version: pkg.version, state: supported ? 'current' : 'old' };
      }
    }
    return { supported: true, version: pkg.version, state: 'current' };
  } catch {
    return { supported: false, version: null, state: 'invalid' };
  }
}

export function warnIfCoreCookieAllowlistUnavailable(options, warn = console.warn) {
  const result = coreSupportsCookieAllowlist(options);
  if (!result.supported) {
    const installed = result.state === 'missing'
      ? 'not found on PATH'
      : (result.version || 'invalid installation');
    warn(`zylos-core >=${MINIMUM_COOKIE_FILTER_CORE_VERSION} is required to enforce the Pages route Cookie allowlist; installed version: ${installed}.`);
  }
  return result;
}
