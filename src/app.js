import express from 'express';
import path from 'node:path';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { notFound, errorHandler } from './middlewares/errorHandler.js';
import { globalLimiter } from './middlewares/rateLimit.js';
import authRoutes from './modules/auth/auth.routes.js';
import catalogRoutes from './modules/catalog/catalog.routes.js';
import shopRoutes from './modules/shops/shops.routes.js';
import listingRoutes from './modules/listings/listings.routes.js';
import cartRoutes from './modules/cart/cart.routes.js';
import checkoutRoutes from './modules/checkout/checkout.routes.js';
import bargainRoutes from './modules/bargains/bargains.routes.js';
import verificationRoutes from './modules/verification/verification.routes.js';
import fulfilmentRoutes from './modules/fulfilment/fulfilment.routes.js';
import reviewRoutes from './modules/reviews/reviews.routes.js';
import dashboardRoutes from './modules/dashboards/dashboards.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';
import adminCatalogRoutes from './modules/adminCatalog/adminCatalog.routes.js';
import userRoutes from './modules/users/users.routes.js';
import staffRoutes from './modules/staff/staff.routes.js';
import uploadRoutes from './modules/uploads/uploads.routes.js';
import returnRoutes from './modules/returns/returns.routes.js';
import notificationRoutes from './modules/notifications/notifications.routes.js';
import shopPhotoRoutes from './modules/shopPhotos/shopPhotos.routes.js';
import tryOnRoutes from './modules/tryOn/tryOn.routes.js';

export const app = express();

// Behind Nginx or a load balancer: trust its X-Forwarded-For so rate limiting sees real client IPs
app.set('trust proxy', env.TRUST_PROXY);

const allowedOrigins = env.CORS_ORIGINS.split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } })); // API data and images must be readable by the frontend (another origin)
// credentials: true lets the website send and receive the session cookie.
// With an empty list any origin is allowed (development); in production list the frontend's address.
app.use(cors({ origin: allowedOrigins.length > 0 ? allowedOrigins : true, credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(
  pinoHttp({
    logger,
    // one short line per request instead of the full request/response objects
    serializers: {
      req: (req) => ({ method: req.method, url: req.url }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
    customLogLevel: (req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  }),
);

app.get('/health', (req, res) => {
  res.json({ success: true, data: { status: 'ok', uptime: process.uptime() } });
});

app.get('/health/db', async (req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.json({ success: true, data: { db: 'ok' } });
});

// Public images are plain files; the names are random UUIDs, so they can be cached for a long time.
// Private documents are NOT served here; they go through GET /api/v1/files/:id with a permission check.
app.use(
  '/uploads/public',
  express.static(path.resolve(env.UPLOAD_DIR, 'public'), {
    index: false,
    dotfiles: 'deny',
    maxAge: '365d',
    immutable: true,
  }),
);

app.use('/api/v1', globalLimiter); // health checks and public images above are not limited
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1', catalogRoutes);
app.use('/api/v1', shopRoutes);
app.use('/api/v1', listingRoutes);
app.use('/api/v1/cart', cartRoutes);
app.use('/api/v1', checkoutRoutes);
app.use('/api/v1', bargainRoutes);
app.use('/api/v1', verificationRoutes);
app.use('/api/v1', fulfilmentRoutes);
app.use('/api/v1', reviewRoutes);
app.use('/api/v1', dashboardRoutes);
app.use('/api/v1', adminRoutes);
app.use('/api/v1', adminCatalogRoutes);
app.use('/api/v1', userRoutes);
app.use('/api/v1', staffRoutes);
app.use('/api/v1', uploadRoutes);
app.use('/api/v1', returnRoutes);
app.use('/api/v1', notificationRoutes);
app.use('/api/v1', shopPhotoRoutes);
app.use('/api/v1', tryOnRoutes);


app.use(notFound);
app.use(errorHandler);