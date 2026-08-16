import path from 'node:path';
import { stat } from 'node:fs/promises';
import { getMimeType } from '../utils/mime.js';

const DEFAULT_MAX_ATTACHMENT_SIZE_BYTES = 50 * 1024 * 1024;

function encodeRFC5987Value(value) {
  return encodeURIComponent(value)
    .replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function attachmentContentDisposition(filePath) {
  const filename = path.basename(filePath);
  const extension = path.extname(filename).toLowerCase();
  const safeExtension = /^\.[a-z0-9]{1,16}$/.test(extension) ? extension : '';
  return `attachment; filename="download${safeExtension}"; filename*=UTF-8''${encodeRFC5987Value(filename)}`;
}

export async function attachmentDescriptorMetadata(descriptor, config = {}) {
  const stats = await stat(descriptor.filePath);
  const maxBytes = config.security?.maxAttachmentSizeBytes ?? DEFAULT_MAX_ATTACHMENT_SIZE_BYTES;
  if (!stats.isFile()) {
    throw Object.assign(new Error('Attachment source is not a file'), { statusCode: 404 });
  }
  if (stats.size > maxBytes) {
    throw Object.assign(
      new Error(`Attachment is ${stats.size} bytes (max ${maxBytes})`),
      { statusCode: 413 },
    );
  }
  const extension = path.extname(descriptor.filePath).toLowerCase();
  return {
    filename: path.basename(descriptor.filePath),
    sizeBytes: stats.size,
    mimeType: getMimeType(extension) || 'application/octet-stream',
    contentDisposition: attachmentContentDisposition(descriptor.filePath),
  };
}

export async function sendAttachmentDownload(res, descriptor, config = {}) {
  const metadata = await attachmentDescriptorMetadata(descriptor, config);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', metadata.mimeType);
  res.setHeader('Content-Disposition', metadata.contentDisposition);
  return new Promise((resolve, reject) => {
    res.sendFile(descriptor.filePath, err => {
      if (!err) {
        resolve();
        return;
      }
      // Once streaming has started there is no valid HTTP error response left
      // to send. Close the partial response instead of letting a caller try to
      // write a second set of headers from its normal error handler.
      if (res.headersSent) {
        res.destroy(err);
        resolve();
        return;
      }
      reject(err);
    });
  });
}
