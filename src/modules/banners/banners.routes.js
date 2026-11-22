import { Router } from 'express';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { bannerUploadLimiter } from '../../middlewares/rateLimit.js';
import { receiveBannerMedia } from '../../middlewares/photoUpload.js';
import { createBannerSchema, updateBannerSchema, reorderSchema, publicListQuery, adminListQuery } from './banners.schema.js';
import * as c from './banners.controller.js';

const router = Router();
const adminOnly = [authenticate, requireRole('ADMIN')];

// public: the home page billboard
router.get('/banners', validateQuery(publicListQuery), c.listPublic);

// admin (reorder is registered before /:id so "reorder" is never read as an id)
router.get('/admin/banners', ...adminOnly, validateQuery(adminListQuery), c.listAdmin);
router.post('/admin/banners', ...adminOnly, bannerUploadLimiter, receiveBannerMedia, validate(createBannerSchema), c.create);
router.patch('/admin/banners/reorder', ...adminOnly, validate(reorderSchema), c.reorder);
router.patch('/admin/banners/:id', ...adminOnly, bannerUploadLimiter, receiveBannerMedia, validate(updateBannerSchema), c.update);
router.delete('/admin/banners/:id', ...adminOnly, c.remove);

export default router;
