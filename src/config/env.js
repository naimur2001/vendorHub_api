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
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;