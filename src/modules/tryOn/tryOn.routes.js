import { Router } from 'express';
import multer from 'multer';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { AppError } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { tryOnQuery, toggleSchema } from './tryOn.schema.js';
import * as c from './tryOn.controller.js';

const router = Router();

// Photos stay in memory only: nothing is written to disk or to the database.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.UPLOAD_MAX_MB * 1024 * 1024, files: 2 },
});

function receivePhotos(req, res, next) {
  upload.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'reference', maxCount: 1 },
  ])(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(new AppError(413, `A photo is larger than ${env.UPLOAD_MAX_MB} MB`));
    if (err.name === 'MulterError') return next(new AppError(400, err.message));
    return next(err);
  });
}

// authenticate is applied per route because this router is mounted at /api/v1
router.get('/products/:slug/try-on', c.info);
router.post('/try-on', authenticate, validateQuery(tryOnQuery), receivePhotos, c.generate);
router.patch('/admin/categories/:id/try-on', authenticate, requireRole('ADMIN'), validate(toggleSchema), c.toggle);

export default router;