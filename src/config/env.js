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
        // search by photo: "mock" for development and tests (no AI call), "gemini" for real recognition
    SEARCH_IMAGE_MODE: z.enum(['off', 'mock', 'gemini']).default('mock'), // off = visual search only (free)
    GEMINI_VISION_MODEL: z.string().default('gemini-2.5-flash'),
        // visual search: where the free CLIP model files are kept after the first download
    CLIP_CACHE_DIR: z.string().default('./models-cache'),
    
    // session cookie for the website (refresh token in an httpOnly cookie)
    COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'), // "none" only if the frontend is on a different site
    COOKIE_SECURE: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')), // unset = on in production only
    COOKIE_DOMAIN: z.string().optional(), // unset = the API's own host (usually right)
    API_DOCS: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
        // DEVELOPMENT/TEST ONLY: new users with these email domains are verified at once (comma list).
    AUTO_VERIFY_EMAIL_DOMAINS: z.string().optional(),
    ACCOUNT_DELETION_GRACE_DAYS: z.coerce.number().int().min(7).max(90).default(30),
    // ---- messaging (order status SMS / WhatsApp): mock = written to the MessageLog table only ----
    MESSAGING_MODE: z.enum(['mock', 'sslwireless', 'twilio-whatsapp']).default('mock'),
    SSLWIRELESS_API_TOKEN: z.string().optional(), // TODO when the account exists
    SSLWIRELESS_SID: z.string().optional(),
    SSLWIRELESS_BASE_URL: z.string().url().default('https://smsplus.sslwireless.com'),
    TWILIO_ACCOUNT_SID: z.string().optional(), // TODO when the account exists
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_WHATSAPP_FROM: z.string().optional(), // e.g. "whatsapp:+14155238886"
    // ---- payments behind ONLINE orders: mock = no gateway (pay-mock and signed mock callbacks) ----
    PAYMENT_MODE: z.enum(['mock', 'bkash', 'nagad']).default('mock'),
    PAYMENT_MOCK_SECRET: z.string().min(16).optional(), // signs mock callbacks; unset = derived from JWT_ACCESS_SECRET
    BKASH_BASE_URL: z.string().url().default('https://tokenized.sandbox.bka.sh/v1.2.0-beta'), // TODO real values
    BKASH_APP_KEY: z.string().optional(),
    BKASH_APP_SECRET: z.string().optional(),
    BKASH_USERNAME: z.string().optional(),
    BKASH_PASSWORD: z.string().optional(),
    NAGAD_BASE_URL: z.string().url().default('https://sandbox.mynagad.com:10080/remote-payment-gateway-1.0'), // TODO
    NAGAD_MERCHANT_ID: z.string().optional(),
    NAGAD_MERCHANT_PRIVATE_KEY: z.string().optional(),
    NAGAD_PUBLIC_KEY: z.string().optional(),
    // ---- courier delivery: mock = no courier calls (fixed prices, fake consignments; tests) ----
    COURIER_MODE: z.enum(['mock', 'live']).default('mock'),
    PATHAO_BASE_URL: z.string().url().optional(), // unset = sandbox or live URL from the provider's sandbox switch
    PATHAO_CLIENT_ID: z.string().optional(),
    PATHAO_CLIENT_SECRET: z.string().optional(),
    PATHAO_USERNAME: z.string().optional(),
    PATHAO_PASSWORD: z.string().optional(),
    PATHAO_WEBHOOK_SECRET: z.string().min(16).optional(), // unset in mock mode = derived from JWT_ACCESS_SECRET
    PATHAO_WEBHOOK_INTEGRATION_SECRET: z.string().optional(), // sent back on Pathao's webhook integration check
  })
  .superRefine((cfg, ctx) => {
    // a real provider needs its keys: fail at startup, not at the first SMS or payment
    const need = {
      sslwireless: ['SSLWIRELESS_API_TOKEN', 'SSLWIRELESS_SID'],
      'twilio-whatsapp': ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM'],
      bkash: ['BKASH_APP_KEY', 'BKASH_APP_SECRET', 'BKASH_USERNAME', 'BKASH_PASSWORD'],
      nagad: ['NAGAD_MERCHANT_ID', 'NAGAD_MERCHANT_PRIVATE_KEY', 'NAGAD_PUBLIC_KEY'],
      live: ['PATHAO_CLIENT_ID', 'PATHAO_CLIENT_SECRET', 'PATHAO_USERNAME', 'PATHAO_PASSWORD', 'PATHAO_WEBHOOK_SECRET'],
    };
    for (const mode of [cfg.MESSAGING_MODE, cfg.PAYMENT_MODE, cfg.COURIER_MODE]) {
      for (const key of need[mode] ?? []) {
        if (!cfg[key]) ctx.addIssue({ code: 'custom', path: [key], message: `Required when using ${mode}` });
      }
    }
        if (cfg.NODE_ENV === 'production' && cfg.AUTO_VERIFY_EMAIL_DOMAINS) {
      ctx.addIssue({ code: 'custom', path: ['AUTO_VERIFY_EMAIL_DOMAINS'], message: 'Not allowed in production' });
    }
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