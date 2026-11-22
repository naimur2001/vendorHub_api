import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { uploadLimiter } from '../../middlewares/rateLimit.js';
import { receiveBannerMedia } from '../../middlewares/photoUpload.js';
import { createBannerSchema, updateBannerSchema, reorderSchema } from './banners.schema.js';
import * as c from './banners.controller.js';

const router = Router();
const adminOnly = [authenticate, requireRole('ADMIN')];

// public: the home page billboard
router.get('/banners', c.listPublic);

// admin (reorder is registered before /:id so "reorder" is never read as an id)
router.get('/admin/banners', ...adminOnly, c.listAdmin);
router.post('/admin/banners', ...adminOnly, uploadLimiter, receiveBannerMedia, validate(createBannerSchema), c.create);
router.patch('/admin/banners/reorder', ...adminOnly, validate(reorderSchema), c.reorder);
router.patch('/admin/banners/:id', ...adminOnly, uploadLimiter, receiveBannerMedia, validate(updateBannerSchema), c.update);
router.delete('/admin/banners/:id', ...adminOnly, c.remove);

export default router;
