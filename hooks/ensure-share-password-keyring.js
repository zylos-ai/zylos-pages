/**
 * Shared post-install / post-upgrade step: make share password custody work
 * out of the box.
 *
 * Policy:
 * - If no keyring path is configured (no PAGES_SHARE_PASSWORD_KEY_FILE env,
 *   no sharing.passwordKeyFile), write a default path into config.json and
 *   create the keyring there.
 * - If a keyring path is configured and the file exists, do nothing.
 * - If a keyring path is configured but the file is missing, do NOT create
 *   one: that is the lost-keyring recovery scenario and it must fail closed
 *   (existing credentials reference key ids a fresh keyring cannot serve).
 *   Warn and leave recovery to the operator.
 * - Never let a custody failure break install/upgrade: warn and continue.
 *
 * The default lives outside the Pages data directory so that a whole-dir
 * backup of pages.db does not implicitly bundle the decryption keys.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  createSharePasswordKeyring,
  resolveSharePasswordKeyFile,
} from '../src/sharing/share-password-keyring.js';

export function defaultSharePasswordKeyFile(home) {
  return path.join(home, 'zylos/vault/credentials/pages/share-password-keys.json');
}

export function ensureSharePasswordKeyring({
  home = process.env.HOME,
  log = console.log,
  warn = console.warn,
} = {}) {
  const configPath = path.join(home, 'zylos/components/pages/config.json');
  try {
    let config = {};
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }

    const configuredKeyFile = resolveSharePasswordKeyFile(config);
    let keyFile = configuredKeyFile;
    if (!keyFile) {
      keyFile = defaultSharePasswordKeyFile(home);
      config.sharing = { ...(config.sharing || {}), passwordKeyFile: keyFile };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      log(`Set sharing.passwordKeyFile to default: ${keyFile}`);
    }

    if (fs.existsSync(keyFile)) {
      log(`Share password keyring already exists: ${keyFile}`);
      return { status: 'exists', keyFile };
    }

    if (configuredKeyFile) {
      warn(
        `WARNING: configured share password keyring is missing: ${keyFile}\n` +
        '  Not auto-creating one: existing protected shares may reference keys\n' +
        '  from the lost keyring. Restore it from backup, or run\n' +
        '  `node src/cli/pages.js share-password keyring init` to start fresh.',
      );
      return { status: 'missing_configured', keyFile };
    }

    const keyring = createSharePasswordKeyring(keyFile);
    log(`Share password keyring initialized: ${keyFile} (${keyring.activeKeyId})`);
    return { status: 'created', keyFile, activeKeyId: keyring.activeKeyId };
  } catch (error) {
    warn(`WARNING: share password keyring setup failed (continuing): ${error.message}`);
    return { status: 'error', message: error.message };
  }
}
