import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { logger } from './logger.js';

const OUTBOX = path.join(process.cwd(), 'logs', 'outbox.jsonl');

// The only mail "driver" for now: it logs the mail. A real provider (SMTP, SendGrid, an SMS gateway)
// replaces the body of this ONE function later; the callers do not change.
// DEMO ONLY: the mail text (with the reset link) goes into the log. Replace before real users reset passwords.
export async function sendMail({ to, subject, text }) {
  if (env.MAIL_MODE !== 'log') throw new Error(`Unsupported MAIL_MODE: ${env.MAIL_MODE}`);

  logger.info({ to, subject, text }, 'mail (log driver)');
  // Outside production the mail is also appended to a file, so the tests can read the reset link.
  if (env.NODE_ENV !== 'production') {
    await mkdir(path.dirname(OUTBOX), { recursive: true });
    await appendFile(OUTBOX, `${JSON.stringify({ at: new Date().toISOString(), to, subject, text })}\n`);
  }
}