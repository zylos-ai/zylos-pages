// Todo API route handlers
// GET /api/todo/:board — list all items
// POST /api/todo/:board — add new item
// PATCH /api/todo/:board/:id — update item (status change)
// DELETE /api/todo/:board/:id — remove item

import path from 'node:path';
import { parseTodoFile, updateItemStatus, deleteItem, addItem } from '../todos/todo-manager.js';
import { logger } from '../utils/logger.js';

/**
 * Sanitize todo input: strip newlines, markdown heading markers, and limit length.
 */
function sanitizeTodoInput(str, maxLen = 200) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/[\r\n]+/g, ' ')    // collapse newlines to spaces
    .replace(/^#{1,6}\s*/g, '')   // strip leading markdown heading markers
    .replace(/\|/g, '—')         // replace pipe (used as ID delimiter in H3)
    .trim()
    .slice(0, maxLen);
}

/**
 * CSRF validation via Origin/Referer headers.
 * Same approach as share-api.js.
 */
function csrfCheck(req, res) {
  const expectedHost = req.headers.host;

  function extractHost(urlOrOrigin) {
    try { return new URL(urlOrOrigin).host; } catch { return null; }
  }

  const origin = req.headers.origin;
  const referer = req.headers.referer;

  if (origin) {
    if (extractHost(origin) !== expectedHost) {
      res.status(403).json({ error: 'CSRF validation failed' });
      return false;
    }
  } else if (referer) {
    if (extractHost(referer) !== expectedHost) {
      res.status(403).json({ error: 'CSRF validation failed' });
      return false;
    }
  } else {
    res.status(403).json({ error: 'CSRF validation failed: missing Origin/Referer' });
    return false;
  }
  return true;
}

/**
 * Parse JSON body from request (no body-parser dependency).
 * Same pattern as share-api.js.
 */
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 4096) {
        reject(Object.assign(new Error('Body too large'), { statusCode: 413 }));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Resolve a board name to its file path from config.
 * @param {string} boardName
 * @param {object} todoConfig - config.todo
 * @returns {string|null} absolute file path or null
 */
function resolveBoardPath(boardName, todoConfig) {
  if (!todoConfig?.boards || !todoConfig.boards[boardName]) return null;
  const board = todoConfig.boards[boardName];
  const boardPath = typeof board === 'string' ? board : board?.file;
  if (!boardPath) return null;
  // If already absolute, use as-is; otherwise resolve relative to HOME
  if (path.isAbsolute(boardPath)) return boardPath;
  return path.join(process.env.HOME, boardPath);
}

/**
 * Register todo API routes on the Express app.
 * Must be called AFTER auth middleware.
 * @param {Express} app
 * @param {object} config - Full config object
 * @param {string} routePrefix - optional route mount prefix when reverse proxy does not strip baseUrl
 */
export function setupTodoApi(app, config, routePrefix = '') {
  const todoConfig = config.todo;

  // GET /api/todo/:board — list all items
  app.get(routePrefix + '/api/todo/:board', (req, res) => {
    const boardPath = resolveBoardPath(req.params.board, todoConfig);
    if (!boardPath) {
      return res.status(404).json({ error: 'Board not found' });
    }

    try {
      const data = parseTodoFile(boardPath);
      res.json({ ok: true, title: data.title, active: data.active, completed: data.completed });
    } catch (err) {
      const status = err.statusCode || 500;
      logger.warn('todo list failed', { err: err.message, board: req.params.board });
      res.status(status).json({ error: err.message });
    }
  });

  // POST /api/todo/:board — add new item
  app.post(routePrefix + '/api/todo/:board', async (req, res) => {
    if (!csrfCheck(req, res)) return;

    if (res.locals.viewerType === 'share') {
      return res.status(403).json({ error: 'Share viewers cannot modify todos' });
    }

    const boardPath = resolveBoardPath(req.params.board, todoConfig);
    if (!boardPath) {
      return res.status(404).json({ error: 'Board not found' });
    }

    try {
      const body = await parseJsonBody(req);
      const { title, metadata } = body;

      if (!title || typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ error: 'Missing or empty title' });
      }

      // Sanitize: strip newlines and markdown control chars from title
      const sanitizedTitle = sanitizeTodoInput(title, 200);
      if (!sanitizedTitle) {
        return res.status(400).json({ error: 'Title is empty after sanitization' });
      }

      // Sanitize metadata values
      const sanitizedMeta = {};
      if (metadata && typeof metadata === 'object') {
        for (const [k, v] of Object.entries(metadata)) {
          if (typeof v === 'string') {
            sanitizedMeta[sanitizeTodoInput(k, 50)] = sanitizeTodoInput(v, 500);
          }
        }
      }

      const item = addItem(boardPath, { title: sanitizedTitle, metadata: sanitizedMeta });
      res.json({ ok: true, item });
    } catch (err) {
      const status = err.statusCode || 500;
      logger.warn('todo add failed', { err: err.message, board: req.params.board });
      res.status(status).json({ error: err.message });
    }
  });

  // PATCH /api/todo/:board/:id — update item (status change)
  app.patch(routePrefix + '/api/todo/:board/:id', async (req, res) => {
    if (!csrfCheck(req, res)) return;

    if (res.locals.viewerType === 'share') {
      return res.status(403).json({ error: 'Share viewers cannot modify todos' });
    }

    const boardPath = resolveBoardPath(req.params.board, todoConfig);
    if (!boardPath) {
      return res.status(404).json({ error: 'Board not found' });
    }

    const itemId = parseInt(req.params.id, 10);
    if (isNaN(itemId)) {
      return res.status(400).json({ error: 'Invalid item ID' });
    }

    try {
      const body = await parseJsonBody(req);
      const { status } = body;

      if (!status || !['active', 'completed'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status. Use "active" or "completed"' });
      }

      const item = updateItemStatus(boardPath, itemId, status);
      res.json({ ok: true, item });
    } catch (err) {
      const statusCode = err.statusCode || 500;
      logger.warn('todo update failed', { err: err.message, board: req.params.board, id: req.params.id });
      res.status(statusCode).json({ error: err.message });
    }
  });

  // DELETE /api/todo/:board/:id — remove item
  app.delete(routePrefix + '/api/todo/:board/:id', (req, res) => {
    if (!csrfCheck(req, res)) return;

    if (res.locals.viewerType === 'share') {
      return res.status(403).json({ error: 'Share viewers cannot modify todos' });
    }

    const boardPath = resolveBoardPath(req.params.board, todoConfig);
    if (!boardPath) {
      return res.status(404).json({ error: 'Board not found' });
    }

    const itemId = parseInt(req.params.id, 10);
    if (isNaN(itemId)) {
      return res.status(400).json({ error: 'Invalid item ID' });
    }

    try {
      deleteItem(boardPath, itemId);
      res.json({ ok: true });
    } catch (err) {
      const statusCode = err.statusCode || 500;
      logger.warn('todo delete failed', { err: err.message, board: req.params.board, id: req.params.id });
      res.status(statusCode).json({ error: err.message });
    }
  });
}
