import { Router } from 'express';
import { z } from 'zod';
import { validateQuery } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/auth.js';
import { uploadLimiter } from '../../middlewares/rateLimit.js';
import { receiveCsv } from '../../middlewares/photoUpload.js';
import * as s from './shopTools.service.js';
import { requireModule, checkLimit } from '../../lib/entitlements.js';


// Mounted at /api/v1. Owner or staff of the shop only (checked in the service).
const router = Router();
const analyticsQuery = z.object({ range: z.enum(['7d', '30d']).default('7d') });

router.get('/shops/:shopId/analytics', authenticate, requireModule('ANALYTICS'), validateQuery(analyticsQuery), async (req, res) => {
  res.json({ success: true, data: await s.analytics(req.user, req.params.shopId, req.validated) });
});
router.post('/shops/:shopId/listings/import', authenticate, requireModule('CSV_IMPORT'), uploadLimiter, receiveCsv, async (req, res) => {
  res.json({ success: true, data: await s.importListings(req.user, req.params.shopId, req.file) });
});

export default router;
