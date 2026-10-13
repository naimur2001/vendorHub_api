import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/auth.js';
import { addItemSchema, updateItemSchema } from './cart.schema.js';
import * as c from './cart.controller.js';

const router = Router();
router.use(authenticate); // every cart route needs a logged-in user

router.get('/', c.get);
router.post('/items', validate(addItemSchema), c.addItem);
router.patch('/items/:itemId', validate(updateItemSchema), c.updateItem);
router.delete('/items/:itemId', c.removeItem);
router.delete('/', c.clear);

export default router;