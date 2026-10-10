// import { Router } from 'express';
// import { validate } from '../../middlewares/validate.js';
// import { authenticate } from '../../middlewares/auth.js';
// import { registerSchema, loginSchema, refreshSchema } from './auth.schema.js';
// import * as controller from './auth.controller.js';
// import { registerSchema, loginSchema, refreshSchema, changePasswordSchema } from './auth.schema.js';
// const router = Router();

// router.post('/register', validate(registerSchema), controller.register);
// router.post('/login', validate(loginSchema), controller.login);
// router.post('/refresh', validate(refreshSchema), controller.refresh);
// router.post('/logout', validate(refreshSchema), controller.logout);
// router.get('/me', authenticate, controller.me);
// //change password
// router.post('/change-password', authenticate, validate(changePasswordSchema), controller.changePassword);
// export default router;

import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/auth.js';
import { registerSchema, loginSchema, refreshSchema, changePasswordSchema } from './auth.schema.js';
import * as controller from './auth.controller.js';

const router = Router();

router.post('/register', validate(registerSchema), controller.register);
router.post('/login', validate(loginSchema), controller.login);
router.post('/refresh', validate(refreshSchema), controller.refresh);
router.post('/logout', validate(refreshSchema), controller.logout);
router.post('/change-password', authenticate, validate(changePasswordSchema), controller.changePassword);
router.get('/me', authenticate, controller.me);

export default router;