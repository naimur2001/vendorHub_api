import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  REFRESH_TOKEN_DAYS: z.coerce.number().default(30),
  // true = POST /orders/:id/pay-mock works (stands in for a payment gateway); set false when a real gateway exists
  MOCK_PAYMENTS: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // bargaining: how long the other side has to respond, and how long an agreed price stays valid
  BARGAIN_TTL_MINUTES: z.coerce.number().positive().default(30),
  BARGAIN_ACCEPTED_HOURS: z.coerce.number().positive().default(24),
  // security
  CORS_ORIGINS: z.string().default(''), // comma-separated allowed origins; empty = any origin (development)
  TRUST_PROXY: z.coerce.number().int().min(0).default(0), // set to 1 behind Nginx so rate limiting sees real client IPs
  RATE_LIMIT_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')), // unset = on in production only
  RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().positive().default(15),
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),
  // mail and links
  APP_URL: z.string().url().default('http://localhost:3000'), // the frontend address used in reset links
  // MAIL_MODE: z.enum(['log']).default('log'), // only the log driver exists for now
    MAIL_MODE: z.enum(['log']).default('log'), // only the log driver exists for now
  // uploads
  UPLOAD_DIR: z.string().default('./uploads'),
  UPLOAD_MAX_MB: z.coerce.number().positive().max(20).default(5),
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'), // used to build file links
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;