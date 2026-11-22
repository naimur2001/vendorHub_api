import { z } from 'zod';

// Plain text: control characters (except line breaks and tabs) are removed; the web shows it as text.
const plain = (s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

export const sendMessageSchema = z.object({
  body: z.string().transform(plain).pipe(z.string().trim().min(1).max(1000)),
});

export const listMessagesQuery = z.object({
  after: z.uuid().optional(), // only messages after this one (for polling)
});
