// Core rendering service using worker_threads for hard timeout (P0-fix)

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pageTemplate } from '../templates/pageTemplate.js';
import { logger } from '../utils/logger.js';

const WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'renderWorker.js');

/**
 * Initialize the render service.
 * With worker_threads, no global init is needed (each worker inits its own shiki).
 */
export function initRenderService(_config = {}) {
  // No-op — workers are self-contained.
  // Kept for API compatibility with index.js.
}

/**
 * Render a markdown file to a complete HTML page.
 * Runs in a worker thread with hard timeout — if the worker exceeds the limit,
 * it is terminated (not just a Promise race).
 *
 * @param {string} filePath - absolute path to the .md file
 * @param {object} config - { allowRawHtml, maxFileSizeBytes, tocMinHeadings, baseUrl, codeTheme, renderTimeoutMs }
 * @returns {{ html: string, etag: string, meta: object, size: number }}
 */
export async function renderPage(filePath, config = {}) {
  const {
    allowRawHtml = false,
    maxFileSizeBytes = 1048576,
    tocMinHeadings = 3,
    baseUrl = '/pages',
    codeTheme = 'github-dark',
    renderTimeoutMs = 5000,
  } = config;

  const { bodyHtml, meta, tocItems, etag, size } = await runWorker(filePath, {
    allowRawHtml,
    maxFileSizeBytes,
    codeTheme,
  }, renderTimeoutMs);

  const showToc = meta.toc !== false && tocItems.length >= tocMinHeadings;

  // Extract slug from filePath: strip contentDir prefix + .md extension
  const slug = filePath
    .replace(/^.*\/public\/pages\//, '')
    .replace(/\.md$/i, '');

  const html = pageTemplate({
    title: meta.title || 'Untitled',
    description: meta.description || '',
    date: meta.date || '',
    tags: meta.tags || [],
    bodyHtml,
    tocItems: showToc ? tocItems : [],
    baseUrl,
    slug,
  });

  return { html, etag, meta, size };
}

/**
 * Run the render worker with a hard timeout.
 * If the worker exceeds timeoutMs, it is terminated.
 */
function runWorker(filePath, config, timeoutMs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: { filePath, config },
    });

    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`Render timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    worker.on('message', (msg) => {
      clearTimeout(timer);
      if (msg.ok) {
        resolve(msg.result);
      } else {
        const err = new Error(msg.error);
        if (msg.code) err.code = msg.code;
        reject(err);
      }
    });

    worker.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    worker.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Worker exited with code ${code}`));
      }
    });
  });
}
