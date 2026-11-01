import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from './logger.js';

const OUTBOX = path.join(process.cwd(), 'logs', 'outbox.jsonl');

// One SMTP connection setup for the whole app, created on first use.
let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      // give up quickly instead of hanging
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  return transporter;
}

// "naimur@gmail.com" -> "na***@gmail.com": enough to debug, not a full address in the logs.
function maskEmail(address) {
  const [name, domain] = String(address).split('@');
  if (!domain) return '***';
  return `${name.slice(0, 2)}***@${domain}`;
}

async function deliverSmtp({ to, subject, text }) {
  const info = await getTransporter().sendMail({
    from: env.MAIL_FROM || env.SMTP_USER,
    to,
    subject,
    text,
  });
  // Never log the text: it can contain a reset link.
  logger.info({ to: maskEmail(to), subject, messageId: info.messageId }, 'mail sent (smtp)');
}

// The single place that sends mail. Callers do not know which driver is used.
export async function sendMail({ to, subject, text }) {
  if (env.MAIL_MODE === 'smtp') {
    // Sent in the background: the API answers at once, so the response time cannot reveal
    // whether an email address is registered (an SMTP send takes 1-3 seconds).
    deliverSmtp({ to, subject, text }).catch((err) => {
      logger.error({ err: err.message, to: maskEmail(to), subject }, 'mail could not be sent (smtp)');
    });
    return;
  }

  if (env.MAIL_MODE !== 'log') throw new Error(`Unsupported MAIL_MODE: ${env.MAIL_MODE}`);

  // DEMO ONLY: the mail text (with the reset link) goes into the log. Used for development and tests.
  logger.info({ to, subject, text }, 'mail (log driver)');
  // Outside production the mail is also appended to a file, so the tests can read the reset link.
  if (env.NODE_ENV !== 'production') {
    await mkdir(path.dirname(OUTBOX), { recursive: true });
    await appendFile(OUTBOX, `${JSON.stringify({ at: new Date().toISOString(), to, subject, text })}\n`);
  }
}