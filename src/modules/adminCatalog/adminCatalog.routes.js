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
import multer from 'multer';
import { uploadLimiter } from '../../middlewares/rateLimit.js';
import { AppError } from '../../lib/errors.js';



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


// Market photo: exactly one file in the field "image", max 5 MB, almost nothing else.
const marketPhoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5, fieldSize: 1024, parts: 6 },
});
function receiveMarketPhoto(req, res, next) {
  marketPhoto.single('image')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(new AppError(413, 'The photo is larger than 5 MB'));
    if (err.name === 'MulterError') return next(new AppError(400, 'Send exactly one photo in the multipart field "image"'));
    return next(err);
  });
}
router.put('/admin/markets/:id/image', ...adminOnly, uploadLimiter, receiveMarketPhoto, c.setMarketImage);
router.delete('/admin/markets/:id/image', ...adminOnly, c.removeMarketImage);



export default router;