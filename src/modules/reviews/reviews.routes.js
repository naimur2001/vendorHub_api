import { Router } from 'express';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/auth.js';
import { createReviewSchema, updateReviewSchema, productReviewsQuery } from './reviews.schema.js';
import * as c from './reviews.controller.js';
import { requireVerifiedEmail } from '../../middlewares/verifiedEmail.js';
import { uploadLimiter } from '../../middlewares/rateLimit.js';
import { receivePhoto } from '../../middlewares/photoUpload.js';

const router = Router();

// authenticate is applied per route because this router is mounted at /api/v1
router.get('/products/:slug/reviews', validateQuery(productReviewsQuery), c.productReviews);
router.post('/reviews', authenticate, requireVerifiedEmail, validate(createReviewSchema), c.create);
router.patch('/reviews/:id', authenticate, validate(updateReviewSchema), c.update);
router.delete('/reviews/:id', authenticate, c.remove);
// photos: up to 3, the author only (a verified buyer), same photo rules as product photos
router.post('/reviews/:id/photos', authenticate, uploadLimiter, receivePhoto, c.addPhoto);
router.delete('/reviews/:id/photos/:photoId', authenticate, c.removePhoto);

export default router;