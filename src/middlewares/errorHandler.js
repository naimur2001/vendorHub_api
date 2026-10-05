import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

export function notFound(req, res, next) {
  next(new AppError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

export function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      success: false,
      error: { message: 'Validation failed', details: err.flatten().fieldErrors },
    });
  }
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: { message: err.message, details: err.details },
    });
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