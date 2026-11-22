import { Router } from 'express';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { addWishlistSchema, listWishlistQuery, productIdParams } from './wishlist.schema.js';

// 400 for a malformed path id (the parsed value is not stored: req.params is used as is)
const validateParams = (schema) => (req, res, next) => {
  schema.parse(req.params);
  next();
};
import * as c from './wishlist.controller.js';

// Mounted at /api/v1/wishlist. Customers only; like the cart, the global API rate limit applies.
const router = Router();
router.use(authenticate, requireRole('CUSTOMER'));

router.get('/', validateQuery(listWishlistQuery), c.list);
router.get('/ids', c.ids);
router.post('/', validate(addWishlistSchema), c.add);
// before /:listingId, so "product" is never read as a listing id
router.delete('/product/:productId', validateParams(productIdParams), c.removeProduct);
router.delete('/:listingId', c.remove);

export default router;
