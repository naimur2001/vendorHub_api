// Provider-neutral outgoing messages (order status SMS / WhatsApp), chosen by MESSAGING_MODE:
//   mock             write to the MessageLog table only (development and tests; costs nothing)
//   sslwireless      SMS through SSL Wireless       (TODO: needs SSLWIRELESS_API_TOKEN, SSLWIRELESS_SID)
//   twilio-whatsapp  WhatsApp through Twilio        (TODO: needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM)
// Every attempt is written to MessageLog with a MASKED phone; full numbers are never logged.
// Best effort: never throws, so a message problem can never break an order change.
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { env } from '../config/env.js';

/** "01712345678" -> "017******78" (enough to recognise it, not enough to use it). */
export const maskPhone = (phone) => (phone && phone.length > 5 ? `${phone.slice(0, 3)}${'*'.repeat(phone.length - 5)}${phone.slice(-2)}` : '***');

const providers = {
  mock: { channel: 'SMS', send: async () => {} }, // the MessageLog row IS the message
  sslwireless: {
    channel: 'SMS',
    // TODO: POST `${env.SSLWIRELESS_BASE_URL}/api/v3/send-sms` with api_token, sid, msisdn, sms, csms_id
    send: async () => {
      throw new Error('SSL Wireless is not connected yet');
    },
  },
  'twilio-whatsapp': {
    channel: 'WHATSAPP',
    // TODO: POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json, From=TWILIO_WHATSAPP_FROM, To=whatsapp:+880...
    send: async () => {
      throw new Error('Twilio WhatsApp is not connected yet');
    },
  },
};

// logBody: what the log keeps when the message itself carries private data (e.g. a shared phone number)
async function send({ userId, phone, template, body, subOrderId, logBody }) {
  const mode = env.MESSAGING_MODE;
  const provider = providers[mode];
  let status = 'SENT';
  let error = null;
  try {
    await provider.send({ to: phone, body });
  } catch {
    status = 'FAILED';
    error = 'The provider did not accept the message'; // fixed text, never the provider's answer
    logger.warn({ provider: mode, template }, 'message not sent'); // no phone number in the log
  }
  await prisma.messageLog.create({
    data: { userId, channel: provider.channel, provider: mode, toMasked: maskPhone(phone), template, body: logBody ?? body, status, error, subOrderId },
  });
}

// ---------- order status messages ----------
const STATUS_TEMPLATES = {
  CONFIRMED: (o) => ['ORDER_CONFIRMED', `Vendors Hub: your order ${o.orderNumber} is confirmed by the shop.`],
  READY_FOR_PICKUP: (o) => ['ORDER_READY_FOR_PICKUP', `Vendors Hub: your order ${o.orderNumber} is ready for pickup at the shop.`],
  OUT_FOR_DELIVERY: (o) => ['ORDER_OUT_FOR_DELIVERY', `Vendors Hub: your order ${o.orderNumber} is out for delivery.`],
  COMPLETED: (o) => ['ORDER_COMPLETED', `Vendors Hub: your order ${o.orderNumber} is completed. Thank you!`],
};

/** After an order status change (committed): an SMS to the customer for the four main steps. */
export async function sendOrderStatusMessage(order, status) {
  try {
    const make = STATUS_TEMPLATES[status];
    if (!make) return;
    const session = await prisma.checkoutSession.findUnique({
      where: { id: order.checkoutId },
      select: { user: { select: { id: true, phone: true, smsOptOut: true } } },
    });
    const user = session?.user;
    if (!user?.phone || user.smsOptOut) return; // no phone, or the customer switched messages off
    const [template, body] = make(order);
    await send({ userId: user.id, phone: user.phone, template, body, subOrderId: order.id });
  } catch (err) {
    logger.error({ err: err.message }, 'could not send the order status message');
  }
}

/**
 * Any other plain-text SMS / WhatsApp (e.g. Shop To-Let), through the same adapter and MessageLog.
 * Best effort: never throws. userId may be null (a guest).
 */
export async function sendPlainMessage({ userId = null, phone, template, body, logBody }) {
  if (!phone) return;
  try {
    await send({ userId, phone, template, body, logBody, subOrderId: null });
  } catch (err) {
    logger.error({ err: err.message, template }, 'could not send a message'); // no phone number
  }
}
