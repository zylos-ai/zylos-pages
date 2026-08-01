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
  loadSharePasswordKeyring,
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
    if (configuredKeyFile) {
      if (fs.existsSync(configuredKeyFile)) {
        log(`Share password keyring already exists: ${configuredKeyFile}`);
        return { status: 'exists', keyFile: configuredKeyFile };
      }
      warn(
        `WARNING: configured share password keyring is missing: ${configuredKeyFile}\n` +
        '  Not auto-creating one: existing protected shares may reference keys\n' +
        '  from the lost keyring. Restore it from backup, or run\n' +
        '  `node src/cli/pages.js share-password keyring init` to start fresh.',
      );
      return { status: 'missing_configured', keyFile: configuredKeyFile };
    }

    // Unconfigured: provision the default. Order matters for retry safety —
    // the config pointer is committed only after a valid keyring exists, so if
    // either half fails the next run can still complete the other half. A
    // pointer written before a failed creation would masquerade as operator
    // configuration and permanently trip the fail-closed branch above.
    const keyFile = defaultSharePasswordKeyFile(home);
    let created = null;
    if (fs.existsSync(keyFile)) {
      loadSharePasswordKeyring(keyFile);
      log(`Adopting existing default share password keyring: ${keyFile}`);
    } else {
      created = createSharePasswordKeyring(keyFile);
      log(`Share password keyring initialized: ${keyFile} (${created.activeKeyId})`);
    }
    config.sharing = { ...(config.sharing || {}), passwordKeyFile: keyFile };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    log(`Set sharing.passwordKeyFile to default: ${keyFile}`);
    return created
      ? { status: 'created', keyFile, activeKeyId: created.activeKeyId }
      : { status: 'adopted', keyFile };
  } catch (error) {
    warn(`WARNING: share password keyring setup failed (continuing): ${error.message}`);
    return { status: 'error', message: error.message };
  }
}
