// Todo board page route handler
// Renders the kanban board HTML for a given board name

import path from 'node:path';
import { parseTodoFile } from '../todos/todo-manager.js';
import { todoTemplate } from '../templates/todoTemplate.js';
import { logger } from '../utils/logger.js';

/**
 * Resolve a board name to its file path from config.
 */
function resolveBoardPath(boardName, todoConfig) {
  if (!todoConfig?.boards || !todoConfig.boards[boardName]) return null;
  const boardPath = todoConfig.boards[boardName];
  if (path.isAbsolute(boardPath)) return boardPath;
  return path.join(process.env.HOME, boardPath);
}

/**
 * Route handler factory for GET /todo/:board
 * @param {object} config - Full config object
 */
export function todoRoute(config) {
  return (req, res) => {
    const boardName = req.params.board;
    const todoConfig = config.todo;

    if (!todoConfig?.boards?.[boardName]) {
      return res.status(404).send('Board not found');
    }

    const boardPath = resolveBoardPath(boardName, todoConfig);
    if (!boardPath) {
      return res.status(404).send('Board not found');
    }

    try {
      const data = parseTodoFile(boardPath);
      const isAuthenticated = res.locals.authenticated;
      const isShareViewer = res.locals.viewerType === 'share';

      const html = todoTemplate({
        title: data.title || boardName,
        boardName,
        active: data.active,
        completed: data.completed,
        baseUrl: '/pages',
        isAuthenticated,
        isShareViewer,
      });

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(html);
    } catch (err) {
      const status = err.statusCode || 500;
      logger.error('todo page render failed', { err: err.message, board: boardName });
      res.status(status).send(status === 404 ? 'Board file not found' : 'Internal Server Error');
    }
  };
}
