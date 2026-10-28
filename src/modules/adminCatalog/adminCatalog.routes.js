import { Router } from 'express';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import {
  categorySchema,
  categoryUpdateSchema,
  brandSchema,
  marketSchema,
  marketUpdateSchema,
  productSchema,
  productUpdateSchema,
  adminProductsQuery,
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

router.get('/admin/products', ...adminOnly, validateQuery(adminProductsQuery), c.listProducts);
router.post('/admin/products', ...adminOnly, validate(productSchema), c.createProduct);
router.patch('/admin/products/:id', ...adminOnly, validate(productUpdateSchema), c.updateProduct);
router.delete('/admin/products/:id', ...adminOnly, c.deactivateProduct);

export default router;