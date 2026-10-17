

// import express from 'express';
// import cors from 'cors';
// import helmet from 'helmet';
// import pinoHttp from 'pino-http';
// import { logger } from './lib/logger.js';
// import { prisma } from './lib/prisma.js';
// import { notFound, errorHandler } from './middlewares/errorHandler.js';
// import authRoutes from './modules/auth/auth.routes.js';
// import catalogRoutes from './modules/catalog/catalog.routes.js';
// import shopRoutes from './modules/shops/shops.routes.js';
// import listingRoutes from './modules/listings/listings.routes.js';
// import cartRoutes from './modules/cart/cart.routes.js';

// export const app = express();

// app.use(helmet());
// app.use(cors());
// app.use(express.json());
// //pinoHttp({ logger }); describe pinoHttp
// app.use(pinoHttp({ logger }));

// app.get('/health', (req, res) => {
//   res.json({ success: true, data: { status: 'ok', uptime: process.uptime() } });
// });

// app.get('/health/db', async (req, res) => {
//   await prisma.$queryRaw`SELECT 1`;
//   res.json({ success: true, data: { db: 'ok' } });
// });

// app.use('/api/v1/auth', authRoutes);
// app.use('/api/v1', catalogRoutes);
// app.use('/api/v1', shopRoutes);
// app.use('/api/v1', listingRoutes);
// app.use('/api/v1/cart', cartRoutes);

// app.use(notFound);
// app.use(errorHandler);

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { notFound, errorHandler } from './middlewares/errorHandler.js';
import authRoutes from './modules/auth/auth.routes.js';
import catalogRoutes from './modules/catalog/catalog.routes.js';
import shopRoutes from './modules/shops/shops.routes.js';
import listingRoutes from './modules/listings/listings.routes.js';
import cartRoutes from './modules/cart/cart.routes.js';
import checkoutRoutes from './modules/checkout/checkout.routes.js';
import bargainRoutes from './modules/bargains/bargains.routes.js';
import verificationRoutes from './modules/verification/verification.routes.js';


export const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } })); // API data must be readable by the frontend (another origin)
app.use(cors());
app.use(express.json());
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

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1', catalogRoutes);
app.use('/api/v1', shopRoutes);
app.use('/api/v1', listingRoutes);
app.use('/api/v1/cart', cartRoutes);
app.use('/api/v1/', checkoutRoutes);
app.use('/api/v1/', bargainRoutes);
app.use('/api/v1', verificationRoutes);


app.use(notFound);
app.use(errorHandler);