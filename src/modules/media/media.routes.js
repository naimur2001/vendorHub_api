// Serves processed public images (markets, shop photos, avatars, product images).
//
// Only server-made names can be served: "<uuid>.webp" and "<uuid>-thumb.webp" from the media folder.
// Any other name (another extension, "../", encoded slashes) is a 404 before the disk is touched.
// The headers make the browser treat the answer strictly as an image:
//   - Content-Type image/webp, and nosniff: never guessed as HTML or script
//   - Content-Security-Policy "default-src 'none'; sandbox": even opened directly, nothing can run
//   - Content-Disposition inline: shown, not downloaded
//   - Cross-Origin-Resource-Policy same-site: our website (and its app wrappers) may embed it, other sites may not
//   - cached for a year, immutable: the name changes whenever a photo changes
import { Router } from 'express';
import { mediaFilePath } from '../../lib/storage.js';
import { AppError } from '../../lib/errors.js';

const router = Router();

const MEDIA_HEADERS = Object.freeze({
  'Content-Type': 'image/webp',
  'X-Content-Type-Options': 'nosniff',
  'Content-Disposition': 'inline',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cross-Origin-Resource-Policy': 'same-site',
});

router.get('/media/:name', (req, res, next) => {
  const file = mediaFilePath(req.params.name);
  if (!file) return next(new AppError(404, 'Not found'));

  res.sendFile(file, { headers: MEDIA_HEADERS, maxAge: '365d', immutable: true, dotfiles: 'deny' }, (err) => {
    if (!err || res.headersSent) return; // sent, or the client went away mid-transfer
    next(err.code === 'ENOENT' || err.status === 404 ? new AppError(404, 'Not found') : err);
  });
});

export default router;