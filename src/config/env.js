import { z } from 'zod';

const schema = z
  .object({
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
    // log = write mails to the log and logs/outbox.jsonl (development and tests)
    // smtp = really send them (Gmail now, a mail service later)
    MAIL_MODE: z.enum(['log', 'smtp']).default('log'),
    SMTP_HOST: z.string().default('smtp.gmail.com'),
    SMTP_PORT: z.coerce.number().int().positive().default(465),
    SMTP_SECURE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'), // true = TLS from the start (port 465)
    SMTP_USER: z.string().optional(), // the Gmail address
    SMTP_PASS: z.string().optional(), // a Gmail App Password, never the normal password
    MAIL_FROM: z.string().optional(), // e.g. "Vendors Hub <you@gmail.com>"; defaults to SMTP_USER
    // uploads
    UPLOAD_DIR: z.string().default('./uploads'),
    UPLOAD_MAX_MB: z.coerce.number().positive().max(20).default(5),
    PUBLIC_API_URL: z.string().url().default('http://localhost:4000'), // used to build file links
    // virtual try-on: "mock" for development and tests (no AI, no cost), "gemini" for real pictures
    TRYON_MODE: z.enum(['mock', 'gemini']).default('mock'),
    GEMINI_API_KEY: z.string().optional(),
    GEMINI_IMAGE_MODEL: z.string().default('gemini-2.5-flash-image'),
    TRYON_DAILY_LIMIT: z.coerce.number().int().positive().default(25), // pictures per customer per day (5 rolls of 5 frames)
    // session cookie for the website (refresh token in an httpOnly cookie)
    COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'), // "none" only if the frontend is on a different site
    COOKIE_SECURE: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')), // unset = on in production only
    COOKIE_DOMAIN: z.string().optional(), // unset = the API's own host (usually right)
    API_DOCS: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  })
  .superRefine((cfg, ctx) => {
    // Real sending needs a login; fail at startup instead of at the first mail.
    if (cfg.MAIL_MODE === 'smtp') {
      if (!cfg.SMTP_USER) ctx.addIssue({ code: 'custom', path: ['SMTP_USER'], message: 'Required when MAIL_MODE=smtp' });
      if (!cfg.SMTP_PASS) ctx.addIssue({ code: 'custom', path: ['SMTP_PASS'], message: 'Required when MAIL_MODE=smtp' });
    }
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;