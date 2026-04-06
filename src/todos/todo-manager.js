// Todo file parser and manager
// Reads/writes todo.md files with Active/Completed sections

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';

let writeLock = false;

/**
 * Parse a todo.md file into structured data.
 * @param {string} filePath - Absolute path to the .md file
 * @returns {{ title: string, active: Array, completed: Array }}
 */
export function parseTodoFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw Object.assign(new Error('Todo file not found'), { statusCode: 404 });
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  let title = '';
  let currentSection = null; // 'active' | 'completed' | null
  const active = [];
  const completed = [];
  let currentBlock = [];
  let inItem = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // H1 — file title (first one only)
    if (/^# /.test(line) && !title) {
      title = line.replace(/^# /, '').trim();
      continue;
    }

    // H2 — section header
    if (/^## /i.test(line)) {
      // Flush current item
      if (inItem && currentBlock.length > 0) {
        const item = parseTodoItem(currentBlock);
        if (item && currentSection === 'active') active.push(item);
        else if (item && currentSection === 'completed') completed.push(item);
      }
      currentBlock = [];
      inItem = false;

      const sectionName = line.replace(/^## /, '').trim().toLowerCase();
      if (sectionName === 'active') currentSection = 'active';
      else if (sectionName === 'completed') currentSection = 'completed';
      else currentSection = null;
      continue;
    }

    // H3 — item header
    if (/^### /.test(line) && currentSection) {
      // Flush previous item
      if (inItem && currentBlock.length > 0) {
        const item = parseTodoItem(currentBlock);
        if (item && currentSection === 'active') active.push(item);
        else if (item && currentSection === 'completed') completed.push(item);
      }
      currentBlock = [line];
      inItem = true;
      continue;
    }

    // Accumulate lines for current item
    if (inItem) {
      currentBlock.push(line);
    }
  }

  // Flush last item
  if (inItem && currentBlock.length > 0) {
    const item = parseTodoItem(currentBlock);
    if (item && currentSection === 'active') active.push(item);
    else if (item && currentSection === 'completed') completed.push(item);
  }

  return { title, active, completed };
}

/**
 * Parse a single H3 block into a todo item.
 * @param {string[]} blockLines - Lines starting with the H3 header
 * @returns {{ id: number, title: string, metadata: object } | null}
 */
export function parseTodoItem(blockLines) {
  if (!blockLines || blockLines.length === 0) return null;

  const headerLine = blockLines[0];
  // Format: ### <id> | <title>
  const headerMatch = headerLine.match(/^###\s+(\d+)\s*\|\s*(.+)/);
  if (!headerMatch) return null;

  const id = parseInt(headerMatch[1], 10);
  const title = headerMatch[2].trim();

  const metadata = {};

  for (let i = 1; i < blockLines.length; i++) {
    const line = blockLines[i].trim();
    // Format: - **key**: value
    const metaMatch = line.match(/^-\s+\*\*(\w+)\*\*:\s*(.*)$/);
    if (metaMatch) {
      metadata[metaMatch[1].toLowerCase()] = metaMatch[2].trim();
    }
  }

  return { id, title, metadata };
}

/**
 * Get the next available ID from a list of items.
 * @param {Array} items - All items (active + completed)
 * @returns {number}
 */
export function getNextId(items) {
  if (!items || items.length === 0) return 1;
  const maxId = Math.max(...items.map(i => i.id));
  return maxId + 1;
}

/**
 * Update an item's status (move between Active/Completed).
 * @param {string} filePath - Path to todo.md
 * @param {number} itemId - The item ID to move
 * @param {string} newStatus - 'active' or 'completed'
 */
export function updateItemStatus(filePath, itemId, newStatus) {
  const data = parseTodoFile(filePath);
  const allItems = [...data.active, ...data.completed];
  const item = allItems.find(i => i.id === itemId);

  if (!item) {
    throw Object.assign(new Error('Item not found'), { statusCode: 404 });
  }

  // Remove from current section
  data.active = data.active.filter(i => i.id !== itemId);
  data.completed = data.completed.filter(i => i.id !== itemId);

  // Add completion date or remove it
  if (newStatus === 'completed') {
    item.metadata.completed = new Date().toISOString().split('T')[0];
    data.completed.unshift(item);
  } else {
    delete item.metadata.completed;
    data.active.push(item);
  }

  writeTodoFile(filePath, data);
  logger.info('todo status updated', { filePath, itemId, newStatus });
  return item;
}

/**
 * Delete an item from the todo file.
 * @param {string} filePath - Path to todo.md
 * @param {number} itemId - The item ID to remove
 */
export function deleteItem(filePath, itemId) {
  const data = parseTodoFile(filePath);
  const activeLen = data.active.length;
  const completedLen = data.completed.length;

  data.active = data.active.filter(i => i.id !== itemId);
  data.completed = data.completed.filter(i => i.id !== itemId);

  if (data.active.length === activeLen && data.completed.length === completedLen) {
    throw Object.assign(new Error('Item not found'), { statusCode: 404 });
  }

  writeTodoFile(filePath, data);
  logger.info('todo item deleted', { filePath, itemId });
}

/**
 * Add a new item to the Active section.
 * @param {string} filePath - Path to todo.md
 * @param {{ title: string, metadata?: object }} itemData
 * @returns {{ id: number, title: string, metadata: object }}
 */
export function addItem(filePath, itemData) {
  const data = parseTodoFile(filePath);
  const allItems = [...data.active, ...data.completed];
  const id = getNextId(allItems);

  const metadata = {
    ...itemData.metadata,
    added: new Date().toISOString().split('T')[0],
  };

  const newItem = { id, title: itemData.title, metadata };
  data.active.push(newItem);

  writeTodoFile(filePath, data);
  logger.info('todo item added', { filePath, id, title: itemData.title });
  return newItem;
}

/**
 * Write structured todo data back to a .md file.
 * Uses a write lock and atomic rename pattern (like share-manager.js).
 */
function writeTodoFile(filePath, data) {
  if (writeLock) {
    throw Object.assign(new Error('Write conflict, try again'), { statusCode: 409 });
  }
  writeLock = true;
  try {
    let content = `# ${data.title || 'Todo'}\n\n`;

    content += '## Active\n\n';
    for (const item of data.active) {
      content += renderItem(item);
    }

    content += '## Completed\n\n';
    for (const item of data.completed) {
      content += renderItem(item);
    }

    const tmp = filePath + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, filePath);
  } finally {
    writeLock = false;
  }
}

/**
 * Render a single todo item as markdown.
 */
function renderItem(item) {
  let block = `### ${item.id} | ${item.title}\n`;
  for (const [key, value] of Object.entries(item.metadata)) {
    if (value !== undefined && value !== null && value !== '') {
      block += `- **${key}**: ${value}\n`;
    }
  }
  block += '\n';
  return block;
}
