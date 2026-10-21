import { Router } from 'express';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/auth.js';
import { createReviewSchema, updateReviewSchema, productReviewsQuery } from './reviews.schema.js';
import * as c from './reviews.controller.js';

const router = Router();

// authenticate is applied per route because this router is mounted at /api/v1
router.get('/products/:slug/reviews', validateQuery(productReviewsQuery), c.productReviews);
router.post('/reviews', authenticate, validate(createReviewSchema), c.create);
router.patch('/reviews/:id', authenticate, validate(updateReviewSchema), c.update);
router.delete('/reviews/:id', authenticate, c.remove);

export default router;