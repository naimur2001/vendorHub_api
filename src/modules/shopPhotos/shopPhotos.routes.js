import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { addPhotoSchema, updatePhotoSchema, verifyPhotoSchema } from './shopPhotos.schema.js';
import * as c from './shopPhotos.controller.js';

const router = Router();
const owner = [authenticate, requireRole('SHOP_OWNER', 'ADMIN')];

// authenticate is applied per route because this router is mounted at /api/v1
router.get('/shops/:slug/photos', c.list);
router.post('/shops/:shopId/photos', ...owner, validate(addPhotoSchema), c.add);
router.patch('/shops/:shopId/photos/:photoId', ...owner, validate(updatePhotoSchema), c.update);
router.delete('/shops/:shopId/photos/:photoId', ...owner, c.remove);
router.patch(
  '/admin/shops/:shopId/photos/:photoId/verify',
  authenticate,
  requireRole('ADMIN'),
  validate(verifyPhotoSchema),
  c.verify,
);

export default router;