import { Router } from 'express';
import { z } from 'zod';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import * as v from './subscriptions.schema.js';
import * as s from './subscriptions.service.js';

const router = Router();
const adminOnly = [authenticate, requireRole('ADMIN')];
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const list = (res, { items, pagination }) => res.json({ success: true, data: items, meta: { pagination } });
const uuids = (...names) => {
  const schema = z.object(Object.fromEntries(names.map((n) => [n, z.uuid()])));
  return (req, res, next) => {
    schema.parse(req.params);
    next();
  };
};

// ---------- admin ----------
router.get('/admin/subscriptions/settings', ...adminOnly, async (req, res) => ok(res, await s.getSubscriptionSettings()));
router.patch('/admin/subscriptions/settings', ...adminOnly, validate(v.settingsSchema), async (req, res) => ok(res, await s.updateSubscriptionSettings(req.user, req.body)));

router.get('/admin/subscription-plans', ...adminOnly, async (req, res) => ok(res, await s.listPlans()));
router.post('/admin/subscription-plans', ...adminOnly, validate(v.planCreateSchema), async (req, res) => ok(res, await s.createPlan(req.user, req.body), 201));
router.patch('/admin/subscription-plans/:id', ...adminOnly, uuids('id'), validate(v.planUpdateSchema), async (req, res) => ok(res, await s.updatePlan(req.user, req.params.id, req.body)));
router.delete('/admin/subscription-plans/:id', ...adminOnly, uuids('id'), async (req, res) => {
  await s.deletePlan(req.user, req.params.id);
  ok(res, { message: 'Plan deleted' });
});
router.put('/admin/subscription-plans/:id/prices', ...adminOnly, uuids('id'), validate(v.pricesSchema), async (req, res) => ok(res, await s.setPrices(req.user, req.params.id, req.body)));

router.get('/admin/subscriptions/summary', ...adminOnly, validateQuery(v.summaryQuery), async (req, res) => ok(res, await s.summary(req.validated)));
router.get('/admin/subscriptions/usage', ...adminOnly, validateQuery(v.usageQuery), async (req, res) => ok(res, await s.usage(req.validated)));
router.get('/admin/subscriptions', ...adminOnly, validateQuery(v.listQuery), async (req, res) => list(res, await s.listSubscriptions(req.validated)));
router.get('/admin/subscriptions/:id', ...adminOnly, uuids('id'), async (req, res) => ok(res, await s.getSubscription(req.params.id)));
router.patch('/admin/subscriptions/:id', ...adminOnly, uuids('id'), validate(v.updateSchema), async (req, res) => ok(res, await s.updateSubscription(req.user, req.params.id, req.body)));
router.post('/admin/subscriptions/:id/payments', ...adminOnly, uuids('id'), validate(v.paymentSchema), async (req, res) => ok(res, await s.recordPayment(req.user, req.params.id, req.body), 201));
router.post('/admin/subscription-payments/:id/refund', ...adminOnly, uuids('id'), validate(v.refundSchema), async (req, res) => ok(res, await s.refundPayment(req.user, req.params.id, req.body)));
router.post('/admin/shops/:shopId/subscription', ...adminOnly, uuids('shopId'), validate(v.startSchema), async (req, res) => ok(res, await s.startSubscription(req.user, req.params.shopId, req.body), 201));

router.get('/admin/subscription-requests', ...adminOnly, validateQuery(v.requestsQuery), async (req, res) => list(res, await s.listRequests(req.validated)));
router.post('/admin/subscription-requests/:id/approve', ...adminOnly, uuids('id'), validate(v.approveSchema), async (req, res) => ok(res, await s.approveRequest(req.user, req.params.id, req.body)));
router.post('/admin/subscription-requests/:id/reject', ...adminOnly, uuids('id'), validate(v.rejectSchema), async (req, res) => ok(res, await s.rejectRequest(req.user, req.params.id, req.body)));

// ---------- shop side (owner / staff; { enabled: false } while subscriptions are off) ----------
router.get('/shops/:shopId/subscription', authenticate, uuids('shopId'), async (req, res) => ok(res, await s.shopSubscription(req.user, req.params.shopId)));
router.get('/shops/:shopId/entitlements', authenticate, uuids('shopId'), async (req, res) => ok(res, await s.shopEntitlements(req.user, req.params.shopId)));
router.post('/shops/:shopId/subscription/request', authenticate, uuids('shopId'), validate(v.requestSchema), async (req, res) => {
  const out = await s.requestPlan(req.user, req.params.shopId, req.body);
  ok(res, out, out.enabled ? 201 : 200);
});

export default router;
