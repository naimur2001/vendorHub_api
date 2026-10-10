import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { notFound, errorHandler } from './middlewares/errorHandler.js';
import { authenticate, requireRole } from './middlewares/auth.js';
import authRoutes from './modules/auth/auth.routes.js';
import catalogRoutes from './modules/catalog/catalog.routes.js';
import shopRoutes from './modules/shops/shops.routes.js';
import listingRoutes from './modules/listings/listings.routes.js';



export const app = express();



app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(pinoHttp({ logger }));

app.get('/health', (req, res) => {
  res.json({ success: true, data: { status: 'ok', uptime: process.uptime() } });
});

app.get('/health/db', async (req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.json({ success: true, data: { db: 'ok' } });
});

app.use('/api/v1/auth', authRoutes);

// TEMPORARY: proves the role guard works. Remove after testing.
// app.get('/api/v1/admin/ping', authenticate, requireRole('ADMIN'), (req, res) => {
//   res.json({ success: true, data: { message: `pong, admin ${req.user.id}` } });
// });


//catalog api
app.use('/api/v1', catalogRoutes);
app.use('/api/v1', shopRoutes);
app.use('/api/v1', listingRoutes);

app.use(notFound);
app.use(errorHandler);
