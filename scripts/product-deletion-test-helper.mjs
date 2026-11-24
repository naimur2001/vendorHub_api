// Test helper for test-product-deletion.ps1 (never used by the app).
//   sweep [--hours-ahead=N]          runs the deletion job once, as if it were N hours from now
//   status <requestId>               prints the request's status and outcome, and whether the product row exists
//   add-listing <shopId> <productId> adds a listing directly (another shop listing it during the 12 hours)
//   listing <listingId>             prints whether the listing exists and how many cart / wishlist rows point at it
//   cleanup <productId...>          deletes the deletion requests of these products (the rest of the
//                                    test data is removed by scripts/product-sorts-test-helper.mjs cleanup)
import { prisma } from '../src/lib/prisma.js';
import { sweepDeletionRequests } from '../src/modules/productDeletion/productDeletion.service.js';

const [command, ...args] = process.argv.slice(2);
let out;
if (command === 'sweep') {
  const arg = args.find((a) => a.startsWith('--hours-ahead='));
  const hours = arg ? Number(arg.split('=')[1]) : 0;
  out = await sweepDeletionRequests(new Date(Date.now() + hours * 60 * 60 * 1000));
} else if (command === 'status') {
  const r = await prisma.productDeletionRequest.findUnique({ where: { id: args[0] } });
  const product = r ? await prisma.product.findUnique({ where: { id: r.productId }, select: { isActive: true } }) : null;
  out = { status: r?.status ?? null, outcome: r?.outcome ?? null, scope: r?.scope ?? null, productExists: !!product, productActive: product?.isActive ?? null };
} else if (command === 'add-listing') {
  // a listing added straight in the database (the API refuses a hidden product): "another shop
  // listed it during the 12 hours"
  const [shopId, productId] = args;
  const l = await prisma.shopListing.create({ data: { shopId, productId, price: 1300, stockQty: 2 } });
  out = { listingId: l.id };
} else if (command === 'listing') {
  const listingId = args[0];
  out = {
    listing: (await prisma.shopListing.count({ where: { id: listingId } })) === 1,
    cartItems: await prisma.cartItem.count({ where: { listingId } }),
    wishlistItems: await prisma.wishlistItem.count({ where: { listingId } }),
  };
} else if (command === 'cleanup' && args.length) {
  out = { requests: (await prisma.productDeletionRequest.deleteMany({ where: { productId: { in: args } } })).count };
} else {
  console.error('usage: sweep [--hours-ahead=N] | status <requestId> | cleanup <productId...>');
  process.exitCode = 1;
}
await prisma.$disconnect();
if (out) console.log(JSON.stringify(out));
