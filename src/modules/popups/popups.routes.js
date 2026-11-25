import { Router } from 'express';
import { z } from 'zod';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate, optionalAuth, requireRole } from '../../middlewares/auth.js';
import { bannerUploadLimiter, popupEventLimiter } from '../../middlewares/rateLimit.js';
import { receiveBannerMedia } from '../../middlewares/photoUpload.js';
import { createPopupSchema, updatePopupSchema, activeQuery, eventSchema, settingsSchema, statsQuery } from './popups.schema.js';
import * as s from './popups.service.js';

const router = Router();
const adminOnly = [authenticate, requireRole('ADMIN')];
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const idParam = (req, res, next) => {
  z.object({ id: z.uuid() }).parse(req.params);
  next();
};

// ---------- public ----------
// The one popup to show (or null). Cacheable for 60 s; the answer depends on the login (audience) and language.
router.get('/popups/active', optionalAuth, validateQuery(activeQuery), async (req, res) => {
  const lang = req.validated.lang ?? (/^bn\b/i.test(req.get('accept-language') ?? '') ? 'bn' : 'en');
  res.set('Cache-Control', `${req.headers.authorization ? 'private' : 'public'}, max-age=60`);
  res.set('Vary', 'Authorization, Accept-Language');
  ok(res, await s.activePopup(req.user, { page: req.validated.page, lang }));
});
// anonymous counts only (no login, no personal data)
router.post('/popups/:id/events', popupEventLimiter, idParam, validate(eventSchema), async (req, res) => ok(res, await s.recordEvent(req.params.id, req.body), 202));

// ---------- admin (settings before /:id) ----------
router.get('/admin/popups/settings', ...adminOnly, async (req, res) => ok(res, await s.getPopupSettings()));
router.patch('/admin/popups/settings', ...adminOnly, validate(settingsSchema), async (req, res) => ok(res, await s.updatePopupSettings(req.user, req.body)));
router.get('/admin/popups', ...adminOnly, async (req, res) => ok(res, await s.listAdmin()));
router.post('/admin/popups', ...adminOnly, bannerUploadLimiter, receiveBannerMedia, validate(createPopupSchema), async (req, res) =>
  ok(res, await s.createPopup(req.user, req.body, req.files), 201),
);
router.patch('/admin/popups/:id', ...adminOnly, idParam, bannerUploadLimiter, receiveBannerMedia, validate(updatePopupSchema), async (req, res) =>
  ok(res, await s.updatePopup(req.user, req.params.id, req.body, req.files)),
);
router.delete('/admin/popups/:id', ...adminOnly, idParam, async (req, res) => {
  await s.deletePopup(req.user, req.params.id);
  ok(res, { message: 'Popup deleted' });
});
router.post('/admin/popups/:id/stop', ...adminOnly, idParam, async (req, res) => ok(res, await s.stopPopup(req.user, req.params.id)));
router.get('/admin/popups/:id/stats', ...adminOnly, idParam, validateQuery(statsQuery), async (req, res) => ok(res, await s.popupStats(req.params.id, req.validated)));

export default router;
