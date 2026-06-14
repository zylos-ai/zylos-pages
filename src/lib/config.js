/**
 * Configuration loader for zylos-pages
 *
 * Loads config from ~/zylos/components/pages/config.json
 * with hot-reload support via file watcher.
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
export const DATA_DIR = process.env.PAGES_DATA_DIR || path.join(HOME, 'zylos/components/pages');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// Default configuration
export const DEFAULT_CONFIG = {
  enabled: true,
  port: 3462,
  contentDir: path.join(HOME, 'zylos/http/public/pages'),
  theme: {
    colorScheme: 'auto',
    codeTheme: 'github-dark',
  },
  cache: {
    enabled: true,
    maxEntries: 200,
    ttlSeconds: 3600,
  },
  toc: {
    enabled: true,
    minHeadings: 3,
  },
  auth: {
    enabled: true,
    password: null,
  },
  security: {
    allowRawHtml: false,
    maxFileSizeBytes: 1048576,
    renderTimeoutMs: 5000,
  },
  rateLimit: {
    windowMs: 60000,
    max: 60,
  },
  sharing: {
    enabled: true,
    allowPermanent: false,
  },
  externalFiles: {
    enabled: true,
    allowedSources: {
      recruit: path.join(HOME, 'zylos/components/recruit'),
    },
  },
  todo: {
    enabled: false,
    boards: {},
  },
};

let config = null;
let configWatcher = null;

/**
 * Load configuration from file
 * @returns {Object} Configuration object
 */
export function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const content = fs.readFileSync(CONFIG_PATH, 'utf8');
      const fileConfig = JSON.parse(content);
      config = deepMerge(DEFAULT_CONFIG, fileConfig);
    } else {
      console.warn(`[pages] Config file not found: ${CONFIG_PATH}`);
      config = { ...DEFAULT_CONFIG };
    }
  } catch (err) {
    console.error(`[pages] Failed to load config: ${err.message}`);
    config = { ...DEFAULT_CONFIG };
  }
  return config;
}

/**
 * Get current configuration
 * @returns {Object} Configuration object
 */
export function getConfig() {
  if (!config) {
    loadConfig();
  }
  // Allow env var override for port
  if (process.env.PAGES_PORT) {
    config.port = parseInt(process.env.PAGES_PORT, 10);
  }

  return config;
}

/**
 * Start watching config file for changes
 * @param {Function} onChange - Callback when config changes
 */
export function watchConfig(onChange) {
  if (configWatcher) {
    configWatcher.close();
  }

  if (fs.existsSync(CONFIG_PATH)) {
    configWatcher = fs.watch(CONFIG_PATH, (eventType) => {
      if (eventType === 'change') {
        console.log('[pages] Config file changed, reloading...');
        loadConfig();
        if (onChange) {
          onChange(config);
        }
      }
    });
  }
}

/**
 * Stop watching config file
 */
export function stopWatching() {
  if (configWatcher) {
    configWatcher.close();
    configWatcher = null;
  }
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
        && target[key] && typeof target[key] === 'object') {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
