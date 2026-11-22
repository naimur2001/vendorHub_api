// Provider-neutral payments behind ONLINE orders, chosen by PAYMENT_MODE:
//   mock   no gateway: create-payment returns a mock redirect; the callback is signed with
//          PAYMENT_MOCK_SECRET (HMAC-SHA256). POST /orders/:id/pay-mock keeps working too.
//   bkash  TODO: bKash Tokenized Checkout (BKASH_BASE_URL, BKASH_APP_KEY, BKASH_APP_SECRET,
//          BKASH_USERNAME, BKASH_PASSWORD): grant token -> create -> execute; refund via /refund.
//   nagad  TODO: Nagad (NAGAD_BASE_URL, NAGAD_MERCHANT_ID, NAGAD_MERCHANT_PRIVATE_KEY, NAGAD_PUBLIC_KEY):
//          initialize -> complete; callback verified with the Nagad public key.
// Every adapter has the same three functions: createPayment, verifyCallback, refund.
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { AppError } from './errors.js';

const mockSecret = () =>
  env.PAYMENT_MOCK_SECRET ?? crypto.createHmac('sha256', env.JWT_ACCESS_SECRET).update('payment-mock').digest('hex');

/** The text a mock callback signature covers (the fields that matter, in a fixed order). */
export const mockSignedText = ({ paymentId, providerRef, status, amount }) => `${paymentId}|${providerRef}|${status}|${amount}`;
export const mockSignature = (fields) => crypto.createHmac('sha256', mockSecret()).update(mockSignedText(fields)).digest('hex');

const sameSignature = (a, b) => {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y); // constant time
};

const notConnected = (name) => {
  throw new AppError(501, `${name} payments are not connected yet`);
};

const adapters = {
  mock: {
    async createPayment(payment) {
      const providerRef = `MOCK-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
      return { providerRef, redirectUrl: `${env.APP_URL}/pay/mock?payment=${payment.id}` };
    },
    // body: { paymentId, providerRef, status: 'PAID'|'FAILED', amount }; header X-Mock-Signature
    verifyCallback(headers, body) {
      if (!sameSignature(headers['x-mock-signature'], mockSignature(body))) return null;
      return { paymentId: body.paymentId, providerRef: body.providerRef, status: body.status, amount: body.amount };
    },
    async refund() {
      return { ok: true };
    },
  },
  bkash: {
    createPayment: () => notConnected('bKash'), // TODO: grant token, POST /tokenized/checkout/create
    verifyCallback: () => null, // TODO: query /tokenized/checkout/payment/status with the paymentID
    refund: () => notConnected('bKash'), // TODO: POST /tokenized/checkout/payment/refund
  },
  nagad: {
    createPayment: () => notConnected('Nagad'), // TODO: /check-out/initialize then /check-out/complete
    verifyCallback: () => null, // TODO: verify the signature with NAGAD_PUBLIC_KEY, then /verify/payment
    refund: () => notConnected('Nagad'), // TODO
  },
};

export const paymentMode = () => env.PAYMENT_MODE;
export const paymentAdapter = (mode = env.PAYMENT_MODE) => adapters[mode];
