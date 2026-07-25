import { createReadStream } from 'node:fs';

/**
 * Send a file as the response body without materialising it in memory.
 *
 * The raw-Markdown routes used to `readFile` the whole source into a string
 * before sending it, so a large page cost one full copy of itself in heap on
 * every request. Streaming removes that amplification, which is the reason
 * these routes do not carry the renderer's `maxFileSizeBytes` ceiling: that
 * limit exists to protect the render worker (highlighting, HTML generation),
 * not a plain file read.
 *
 * Streaming moves the "file is missing" failure from before the response to
 * during it, so the error path is the part that needs care. Headers are set on
 * `open`, which fires before any bytes flow — so an `error` raised instead of
 * `open` still lands on an untouched response and can be turned into a normal
 * status code. Once bytes are out the door there is no status code left to
 * send, and the only honest move is to destroy the connection rather than
 * append an error message to a partial body.
 *
 * @param {import('express').Response} res
 * @param {string} filePath absolute path to the file to send
 * @param {object} options
 * @param {string} options.contentType value for the Content-Type header
 * @param {(err: NodeJS.ErrnoException) => void} options.onError called only
 *   when the failure happened before any bytes were written, i.e. when the
 *   caller can still choose a status code
 */
export function streamFileResponse(res, filePath, { contentType, onError }) {
  const stream = createReadStream(filePath);

  stream.once('open', () => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', contentType);
    res.status(200);
  });

  stream.once('error', (err) => {
    if (res.headersSent) {
      // A partial body is already on the wire; there is no status code left to
      // correct it with, so fail loudly at the transport instead of silently
      // returning a truncated document that looks complete.
      stream.destroy();
      res.destroy(err);
      return;
    }
    onError(err);
  });

  // Nothing is written until the stream emits data, which is strictly after
  // 'open' — so attaching the pipe here does not race the header assignment.
  stream.pipe(res);
}
