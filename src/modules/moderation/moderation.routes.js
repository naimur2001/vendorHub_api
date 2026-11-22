import { Router } from 'express';
import { z } from 'zod';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import * as s from './moderation.service.js';

const router = Router();
const adminOnly = [authenticate, requireRole('ADMIN')];
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const list = (res, { items, pagination }) => res.json({ success: true, data: items, meta: { pagination } });

const kind = z.enum(['SHOP', 'PRODUCT']);
const optDate = z.coerce.date().nullable().optional();
const page = { page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(50).default(20) };

// ---------- featured (public + admin) ----------
router.get('/featured', validateQuery(z.object({ kind })), async (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  ok(res, await s.publicFeatured(req.validated));
});
router.get('/admin/featured', ...adminOnly, validateQuery(z.object({ kind: kind.optional() })), async (req, res) =>
  ok(res, await s.listFeaturedAdmin(req.validated)),
);
router.post(
  '/admin/featured',
  ...adminOnly,
  validate(z.object({ kind, targetId: z.uuid(), startsAt: optDate, endsAt: optDate })),
  async (req, res) => ok(res, await s.createFeatured(req.user, req.body), 201),
);
router.patch(
  '/admin/featured/reorder',
  ...adminOnly,
  validate(z.object({ ids: z.array(z.uuid()).min(1).max(50).refine((a) => new Set(a).size === a.length, 'Each item can appear only once') })),
  async (req, res) => ok(res, await s.reorderFeatured(req.user, req.body.ids)),
);
router.patch(
  '/admin/featured/:id',
  ...adminOnly,
  validate(z.object({ startsAt: optDate, endsAt: optDate }).refine((o) => Object.keys(o).length > 0, 'Provide startsAt or endsAt')),
  async (req, res) => ok(res, await s.updateFeatured(req.user, req.params.id, req.body)),
);
router.delete('/admin/featured/:id', ...adminOnly, async (req, res) => {
  await s.deleteFeatured(req.user, req.params.id);
  ok(res, { message: 'Featured item removed' });
});

// ---------- product moderation (admin) ----------
router.get(
  '/admin/moderation/products',
  ...adminOnly,
  validateQuery(z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).default('PENDING'), ...page })),
  async (req, res) => list(res, await s.listModeration(req.validated)),
);
router.post('/admin/moderation/products/:id/approve', ...adminOnly, async (req, res) => ok(res, await s.approveProduct(req.user, req.params.id)));
router.post(
  '/admin/moderation/products/:id/reject',
  ...adminOnly,
  validate(z.object({ reason: z.string().trim().min(3).max(300) })),
  async (req, res) => ok(res, await s.rejectProduct(req.user, req.params.id, req.body.reason)),
);

// ---------- flags ----------
const reasons = ['SPAM', 'ABUSE', 'SCAM', 'PERSONAL_INFO', 'OFF_TOPIC', 'OTHER'];
router.post(
  '/flags',
  authenticate,
  validate(
    z.object({
      targetType: z.enum(['REVIEW', 'ORDER_MESSAGE', 'REVIEW_PHOTO']),
      targetId: z.uuid(),
      reason: z.enum(reasons),
      note: z.string().trim().max(500).optional(),
    }),
  ),
  async (req, res) => {
    const { created, flag } = await s.report(req.user, req.body);
    ok(res, flag, created ? 201 : 200);
  },
);
router.get(
  '/admin/flags',
  ...adminOnly,
  validateQuery(z.object({ status: z.enum(['OPEN', 'HIDDEN', 'KEPT']).default('OPEN'), targetType: z.enum(['REVIEW', 'ORDER_MESSAGE', 'REVIEW_PHOTO']).optional(), ...page })),
  async (req, res) => list(res, await s.listFlags(req.validated)),
);
router.post(
  '/admin/flags/:id/resolve',
  ...adminOnly,
  validate(z.object({ action: z.enum(['HIDE', 'KEEP']), note: z.string().trim().max(500).optional() })),
  async (req, res) => ok(res, await s.resolveFlag(req.user, req.params.id, req.body)),
);

export default router;
