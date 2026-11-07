import { Router } from 'express';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { similarQuery, createShopProductSchema, updateShopProductSchema } from './shopProducts.schema.js';
import * as c from './shopProducts.controller.js';
import { uploadLimiter } from '../../middlewares/rateLimit.js';
import { receivePhoto } from '../../middlewares/photoUpload.js';
import { requireVerifiedEmail } from '../../middlewares/verifiedEmail.js';
const router = Router();
const shopTeam = [authenticate, requireRole('SHOP_OWNER', 'SHOP_STAFF', 'ADMIN')];

router.get('/shops/:shopId/products/similar', ...shopTeam, validateQuery(similarQuery), c.similar);
router.post('/shops/:shopId/products', ...shopTeam, requireVerifiedEmail, validate(createShopProductSchema), c.create);
router.patch('/shops/:shopId/products/:productId', ...shopTeam, validate(updateShopProductSchema), c.update);
router.put('/shops/:shopId/products/:productId/images', ...shopTeam, uploadLimiter, receivePhoto, c.addPhoto);
router.delete('/shops/:shopId/products/:productId/images/:imageId', ...shopTeam, c.removePhoto);

export default router;