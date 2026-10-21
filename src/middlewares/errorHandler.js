import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

export function notFound(req, res, next) {
  next(new AppError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

export function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    const { fieldErrors, formErrors } = err.flatten();
    return res.status(400).json({
      success: false,
      error: {
        message: 'Validation failed',
        // whole-object problems (like unknown fields) go under _form
        details: formErrors.length ? { ...fieldErrors, _form: formErrors } : fieldErrors,
      },
    });
  }
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: { message: err.message, details: err.details },
    });
  }
  // malformed JSON or a body that is too large (thrown by express.json)
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: { message: 'Malformed JSON in the request body' } });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: { message: 'The request body is too large' } });
  }
  // known database errors: unique violation and record not found
  if (err.code === 'P2002') {
    return res.status(409).json({ success: false, error: { message: 'This record already exists' } });
  }
  if (err.code === 'P2025') {
    return res.status(404).json({ success: false, error: { message: 'Record not found' } });
  }
  logger.error(err);
  res.status(500).json({
    success: false,
    error: {
      message: 'Internal server error',
      // only in development, so the real cause shows up in the response
      ...(env.NODE_ENV === 'development' && { debug: err.message }),
    },
  });
}