import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../lib/config.js';
import { assertValidArtifactId, assertValidAttachmentId } from './validation.js';

export const IMAGE_MIME_TO_EXTENSION = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

export function generateAttachmentId() {
  return crypto.randomBytes(16).toString('hex');
}

export function extensionForMimeType(mimeType) {
  return IMAGE_MIME_TO_EXTENSION.get(mimeType) || null;
}

export function sanitizeOriginalFilename(filename) {
  const base = path.basename(String(filename || 'upload'));
  return base.slice(0, 255) || 'upload';
}

export function attachmentRoot() {
  return path.join(DATA_DIR, 'attachments');
}

export function tmpRoot() {
  return path.join(attachmentRoot(), '.tmp');
}

function assertInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith('..') || path.resolve(resolvedRoot, rel) !== resolvedTarget) {
    throw Object.assign(new Error('Attachment path escapes root'), { statusCode: 400 });
  }
}

export async function ensureAttachmentDirs(artifact) {
  assertValidArtifactId(artifact);
  await mkdir(path.join(attachmentRoot(), artifact), { recursive: true });
  await mkdir(tmpRoot(), { recursive: true });
}

export async function ensureTmpDir() {
  await mkdir(tmpRoot(), { recursive: true });
}

export function finalStoredFilename(attachmentId, extension) {
  assertValidAttachmentId(attachmentId);
  if (!['.jpg', '.png', '.webp'].includes(extension)) {
    throw Object.assign(new Error('Invalid attachment extension'), { statusCode: 400 });
  }
  return `${attachmentId}${extension}`;
}

export function resolveFinalPath(artifact, storedFilename) {
  assertValidArtifactId(artifact);
  if (!/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(storedFilename || '')) {
    throw Object.assign(new Error('Invalid stored filename'), { statusCode: 400 });
  }
  const root = attachmentRoot();
  const artifactDir = path.join(root, artifact);
  const filePath = path.join(artifactDir, storedFilename);
  assertInside(root, filePath);
  assertInside(artifactDir, filePath);
  return filePath;
}

export function tmpPathForUpload() {
  const filename = `${Date.now()}-${crypto.randomBytes(12).toString('hex')}.upload`;
  const filePath = path.join(tmpRoot(), filename);
  assertInside(tmpRoot(), filePath);
  return filePath;
}

export async function moveTempToFinal(tempPath, finalPath) {
  await mkdir(path.dirname(finalPath), { recursive: true });
  await rename(tempPath, finalPath);
}

export async function unlinkIfExists(filePath) {
  try {
    await rm(filePath, { force: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

export async function fileSize(filePath) {
  const info = await stat(filePath);
  return info.size;
}

export async function readMagicBytes(filePath, length = 16) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function assertMagicMatchesMime(filePath, mimeType) {
  const bytes = await readMagicBytes(filePath, 16);
  let valid = false;
  if (mimeType === 'image/jpeg') {
    valid = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  } else if (mimeType === 'image/png') {
    valid = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  } else if (mimeType === 'image/webp') {
    valid = bytes.length >= 12
      && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  if (!valid) {
    throw Object.assign(new Error('Uploaded file does not match declared MIME type'), { statusCode: 400 });
  }
}
