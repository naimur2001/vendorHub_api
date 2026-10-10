import { Router } from 'express';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate, optionalAuth, requireRole } from '../../middlewares/auth.js';
import { shopProductsQuery, shopReviewsQuery, createShopSchema, updateShopSchema } from './shops.schema.js';
import * as c from './shops.controller.js';

const router = Router();

router.get('/markets', c.markets);
router.get('/markets/:slug', c.market);

router.post('/shops', authenticate, requireRole('SHOP_OWNER', 'ADMIN'), validate(createShopSchema), c.createShop);
router.get('/shops/:slug', optionalAuth, c.shop);
router.get('/shops/:slug/products', validateQuery(shopProductsQuery), c.shopProducts);
router.get('/shops/:slug/categories', c.shopCategories);
router.get('/shops/:slug/reviews', validateQuery(shopReviewsQuery), c.shopReviews);
router.post('/shops/:slug/follow', authenticate, c.follow);
router.delete('/shops/:slug/follow', authenticate, c.unfollow);
router.patch('/shops/:shopId', authenticate, requireRole('SHOP_OWNER', 'ADMIN'), validate(updateShopSchema), c.updateShop);
export default router;