// DEVELOPMENT TOOL for test-adapters.ps1: prints the X-Mock-Signature for a mock payment callback.
// Usage: node --env-file=.env scripts/sign-mock-callback.mjs <paymentId> <providerRef> <PAID|FAILED> <amount>
import { mockSignature } from '../src/lib/payments.js';

const [paymentId, providerRef, status, amount] = process.argv.slice(2);
if (!amount) {
  console.error('Usage: sign-mock-callback.mjs <paymentId> <providerRef> <PAID|FAILED> <amount>');
  process.exit(1);
}
console.log(mockSignature({ paymentId, providerRef, status, amount: Number(amount) }));
