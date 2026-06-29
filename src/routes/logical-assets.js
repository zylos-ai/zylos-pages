import { readFile, stat } from 'node:fs/promises';
import { resolveLogicalAsset } from '../pages/asset-resolver.js';
import { verifyShareAssetSignature } from '../sharing/share-manager.js';
import { generateEtag } from '../utils/etag.js';
import { logger } from '../utils/logger.js';

export function setupLogicalAssetRoute(app, config) {
  app.get('/assets/:uri(*)', async (req, res, next) => {
    const pageUri = req.params.uri || req.params[0] || '';
    const assetPath = req.query.path;
    if (!pageUri || typeof assetPath !== 'string') return next();

    try {
      const signedRequest = typeof req.query.exp === 'string' || typeof req.query.sig === 'string';
      const { filePath, mimeType } = await resolveLogicalAsset(pageUri, assetPath, {
        config,
        allowConfiguredRoots: signedRequest,
      });
      if (signedRequest) {
        const verification = verifyShareAssetSignature({
          uri: pageUri,
          realPath: filePath,
          expiresAt: Number(req.query.exp),
          sig: req.query.sig,
        });
        if (!verification.valid) {
          return res.status(403).send('Invalid asset signature');
        }
        res.locals.viewerType = 'share';
      }
      const info = await stat(filePath);
      const maxFileSizeBytes = config.security?.maxFileSizeBytes ?? 1048576;
      if (info.size > maxFileSizeBytes) {
        return res.status(413).send(`File too large: ${info.size} bytes (max ${maxFileSizeBytes})`);
      }
      const content = await readFile(filePath);
      const etag = generateEtag(content);
      res.setHeader('Content-Type', mimeType);
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', res.locals.viewerType === 'share' ? 'no-store' : 'public, max-age=3600');
      if (req.headers['if-none-match'] === etag) {
        logger.info('logical asset served', { pageUri, assetPath, status: 304 });
        return res.status(304).end();
      }
      logger.info('logical asset served', { pageUri, assetPath, status: 200 });
      return res.send(content);
    } catch (err) {
      if (err.statusCode) {
        logger.warn('logical asset rejected', { pageUri, assetPath, status: err.statusCode, err: err.message });
        return res.status(err.statusCode).send(err.message);
      }
      return next(err);
    }
  });
}
