import { Router } from 'express';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/auth.js';
import { createDealSchema, createCouponSchema, updateCouponSchema, publicDealsQuery } from './promotions.schema.js';
import * as s from './promotions.service.js';
import { requireModule, checkLimit } from '../../lib/entitlements.js';


// Mounted at /api/v1. Deal and coupon management: the shop's owner or staff (checked in the service).
const router = Router();
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

// public: the home page "Flash deals" row (cached briefly; deals change by the minute)
router.get('/deals', validateQuery(publicDealsQuery), async (req, res) => {
  res.set('Cache-Control', 'public, max-age=30');
  ok(res, await s.publicDeals(req.validated));
});

router.get('/shops/:shopId/deals', authenticate, async (req, res) => ok(res, await s.listShopDeals(req.user, req.params.shopId)));
router.post('/shops/:shopId/deals', authenticate, validate(createDealSchema), requireModule('PROMOTIONS'), checkLimit('maxActiveDeals'), async (req, res) =>
  ok(res, await s.createDeal(req.user, req.params.shopId, req.body), 201),
);
router.delete('/shops/:shopId/deals/:dealId', authenticate, async (req, res) => {
  await s.endDeal(req.user, req.params.shopId, req.params.dealId);
  ok(res, { message: 'Deal ended' });
});

router.get('/shops/:shopId/coupons', authenticate, async (req, res) => ok(res, await s.listCoupons(req.user, req.params.shopId)));
router.post('/shops/:shopId/coupons', authenticate, validate(createCouponSchema), requireModule('PROMOTIONS'), async (req, res) =>
  ok(res, await s.createCoupon(req.user, req.params.shopId, req.body), 201),
);
router.patch('/shops/:shopId/coupons/:couponId', authenticate, validate(updateCouponSchema), async (req, res) =>
  ok(res, await s.updateCoupon(req.user, req.params.shopId, req.params.couponId, req.body)),
);

export default router;
