import { Router } from 'express';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { uploadLimiter } from '../../middlewares/rateLimit.js';
import { receivePhoto } from '../../middlewares/photoUpload.js';
import {
  categorySchema,
  categoryUpdateSchema,
  brandSchema,
  marketSchema,
  marketUpdateSchema,
  productSchema,
  productUpdateSchema,
  adminProductsQuery,
  mergeProductSchema,
} from './adminCatalog.schema.js';
import * as c from './adminCatalog.controller.js';

const router = Router();
const adminOnly = [authenticate, requireRole('ADMIN')];

// authenticate is applied per route because this router is mounted at /api/v1
router.post('/admin/categories', ...adminOnly, validate(categorySchema), c.createCategory);
router.patch('/admin/categories/:id', ...adminOnly, validate(categoryUpdateSchema), c.updateCategory);
router.delete('/admin/categories/:id', ...adminOnly, c.deleteCategory);

router.post('/admin/brands', ...adminOnly, validate(brandSchema), c.createBrand);
router.patch('/admin/brands/:id', ...adminOnly, validate(brandSchema), c.updateBrand);
router.delete('/admin/brands/:id', ...adminOnly, c.deleteBrand);

router.post('/admin/markets', ...adminOnly, validate(marketSchema), c.createMarket);
router.patch('/admin/markets/:id', ...adminOnly, validate(marketUpdateSchema), c.updateMarket);
router.delete('/admin/markets/:id', ...adminOnly, c.deleteMarket);

// Market photo: one file in the field "image" (shared photo rules, see middlewares/photoUpload.js)
router.put('/admin/markets/:id/image', ...adminOnly, uploadLimiter, receivePhoto, c.setMarketImage);
router.delete('/admin/markets/:id/image', ...adminOnly, c.removeMarketImage);

router.get('/admin/products', ...adminOnly, validateQuery(adminProductsQuery), c.listProducts);
router.post('/admin/products', ...adminOnly, validate(productSchema), c.createProduct);
router.patch('/admin/products/:id', ...adminOnly, validate(productUpdateSchema), c.updateProduct);
router.delete('/admin/products/:id', ...adminOnly, c.deactivateProduct);

// Product photos (admin): same rules as market photos; an admin change locks the product for shops
router.put('/admin/products/:id/images', ...adminOnly, uploadLimiter, receivePhoto, c.addProductPhoto);
router.delete('/admin/products/:id/images/:imageId', ...adminOnly, c.removeProductPhoto);
router.post('/admin/products/:id/lock', ...adminOnly, c.lockProduct);
router.post('/admin/products/:id/unlock', ...adminOnly, c.unlockProduct);
router.post('/admin/products/:id/merge', ...adminOnly, validate(mergeProductSchema), c.mergeProduct);

export default router;