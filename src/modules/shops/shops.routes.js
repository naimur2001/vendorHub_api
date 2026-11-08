import { Router } from 'express';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate, optionalAuth, requireRole } from '../../middlewares/auth.js';
import { shopProductsQuery, shopReviewsQuery, shopSearchQuery, createShopSchema, updateShopSchema } from './shops.schema.js';
import * as c from './shops.controller.js';
import { requireVerifiedEmail } from '../../middlewares/verifiedEmail.js';
import { uploadLimiter } from '../../middlewares/rateLimit.js';
import { receivePhoto } from '../../middlewares/photoUpload.js';
const router = Router();
const ownerOrAdmin = [authenticate, requireRole('SHOP_OWNER', 'ADMIN')];

router.get('/markets', c.markets);
router.get('/markets/:slug', c.market);

router.post('/shops', authenticate, requireRole('SHOP_OWNER', 'ADMIN'), requireVerifiedEmail, validate(createShopSchema), c.createShop);
router.get('/shops', validateQuery(shopSearchQuery), c.searchShops);
router.get('/shops/:slug', optionalAuth, c.shop);
router.get('/shops/:slug/products', validateQuery(shopProductsQuery), c.shopProducts);
router.get('/shops/:slug/categories', c.shopCategories);
router.get('/shops/:slug/reviews', validateQuery(shopReviewsQuery), c.shopReviews);
router.post('/shops/:slug/follow', authenticate, c.follow);
router.delete('/shops/:slug/follow', authenticate, c.unfollow);
router.patch('/shops/:shopId', authenticate, requireRole('SHOP_OWNER', 'ADMIN'), validate(updateShopSchema), c.updateShop);
router.put('/shops/:shopId/logo', ...ownerOrAdmin, uploadLimiter, receivePhoto, c.setLogo);
router.delete('/shops/:shopId/logo', ...ownerOrAdmin, c.removeLogo);
router.put('/shops/:shopId/banner', ...ownerOrAdmin, uploadLimiter, receivePhoto, c.setBanner);
router.delete('/shops/:shopId/banner', ...ownerOrAdmin, c.removeBanner);










export default router;