import { Router } from 'express';
import { validateQuery } from '../../middlewares/validate.js';
import { optionalAuth } from '../../middlewares/auth.js';
import { listProductsQuery, productDetailQuery, productListingsQuery } from './catalog.schema.js';
import * as controller from './catalog.controller.js';

const router = Router();

router.get('/categories', controller.categories);
router.get('/brands', controller.brands);
router.get('/products', validateQuery(listProductsQuery), controller.products);
// optionalAuth: a logged-in visitor is counted once per day across devices (analytics only)
router.get('/products/:slug', optionalAuth, validateQuery(productDetailQuery), controller.product);
router.get('/products/:slug/listings', validateQuery(productListingsQuery), controller.productListings);
export default router;