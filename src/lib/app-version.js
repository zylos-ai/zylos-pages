import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Read the component version from package.json at startup — never hardcoded in markup.
export const APP_VERSION = (() => {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '';
  } catch {
    return '';
  }
})();
