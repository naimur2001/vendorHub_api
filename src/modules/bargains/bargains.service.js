import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { assertShopAccess } from '../../lib/shopAccess.js';
import { getCart } from '../cart/cart.service.js';

const MIN_OFFER_PERCENT = 70; // lowest offer a customer may make (Figma slider: 70%-100%)
const MAX_OFFERS = 6; // offers + counter-offers allowed in one negotiation
const ACTIVE = ['AWAITING_SHOP', 'COUNTERED']; // someone still has to respond
const LIVE = [...ACTIVE, 'ACCEPTED']; // statuses that end when expiresAt passes

const inMinutes = (n) => new Date(Date.now() + n * 60 * 1000);
const responseDeadline = () => inMinutes(env.BARGAIN_TTL_MINUTES);
const buyDeadline = () => inMinutes(env.BARGAIN_ACCEPTED_HOURS * 60);

const bargainInclude = {
  listing: {
    include: {
      product: { select: { id: true, slug: true, title: true, images: true } },
      shop: { select: { id: true, name: true, slug: true, isActive: true } },
    },
  },
  customer: { select: { name: true } },
  events: { orderBy: { createdAt: 'asc' } },
};

const offerBounds = (listPrice) => ({
  min: Math.ceil((listPrice * MIN_OFFER_PERCENT) / 100),
  max: listPrice - 1,
});

// Offers at or above the shop's private minimum are accepted automatically.
// A shop that never wants this sets minOfferPercent to 100.
const meetsShopMinimum = (listing, amount) =>
  amount >= Math.ceil((listing.price * listing.minOfferPercent) / 100);

const isYourTurn = (status, actor) =>
  (actor === 'SHOP' && status === 'AWAITING_SHOP') ||
  (actor === 'CUSTOMER' && status === 'COUNTERED');

const effectiveStatus = (b) =>
  LIVE.includes(b.status) && b.expiresAt < new Date() ? 'EXPIRED' : b.status;

function format(b, actor) {
  const status = effectiveStatus(b);
  return {
    id: b.id,
    status,
    listPrice: b.listPrice,
    currentOffer: b.currentOffer,
    agreedPrice: b.agreedPrice,
    expiresAt: b.expiresAt,
    secondsLeft: LIVE.includes(status)
      ? Math.max(0, Math.round((b.expiresAt - Date.now()) / 1000))
      : 0,
    createdAt: b.createdAt,
    yourTurn: ACTIVE.includes(status) && isYourTurn(status, actor),
    product: {
      id: b.listing.product.id,
      slug: b.listing.product.slug,
      title: b.listing.product.title,
      image: b.listing.product.images[0] ?? null,
    },
    shop: { id: b.listing.shop.id, name: b.listing.shop.name, slug: b.listing.shop.slug },
    listing: { id: b.listing.id, price: b.listing.price, availability: b.listing.availability },
    ...(actor === 'SHOP' && { customer: { name: b.customer.name } }),
    events: b.events.map((e) => ({
      id: e.id,
      actor: e.actor,
      amount: e.amount,
      note: e.note,
      createdAt: e.createdAt,
    })),
  };
}

const summarize = (b, actor) => {
  const { events, ...rest } = format(b, actor);
  return rest;
};

// Loads a negotiation and closes it first if its time has run out.
async function loadBargain(id) {
  let b = await prisma.bargain.findUnique({ where: { id }, include: bargainInclude });
  if (b && LIVE.includes(b.status) && b.expiresAt < new Date()) {
    await prisma.$transaction(async (tx) => {
      const closed = await tx.bargain.updateMany({
        where: { id, status: b.status },
        data: { status: 'EXPIRED' },
      });
      if (closed.count === 1) {
        await tx.bargainEvent.create({
          data: {
            bargainId: id,
            actor: 'SYSTEM',
            note: b.status === 'ACCEPTED' ? 'Agreed price expired unused' : 'Offer expired',
          },
        });
      }
    });
    b = await prisma.bargain.findUnique({ where: { id }, include: bargainInclude });
  }
  return b;
}

// Called every minute from server.js; also used before listing negotiations.
export async function expireStaleBargains() {
  const stale = await prisma.bargain.findMany({
    where: { status: { in: LIVE }, expiresAt: { lt: new Date() } },
    select: { id: true },
  });
  for (const { id } of stale) await loadBargain(id);
  return stale.length;
}

// Who is this user in this negotiation? Strangers get 404, so ids cannot be probed.
async function loadForActor(user, id) {
  const b = await loadBargain(id);
  if (!b) throw new AppError(404, 'Negotiation not found');

  let actor = null;
  if (b.customerId === user.id) {
    actor = 'CUSTOMER';
  } else {
    try {
      await assertShopAccess(user, b.listing.shopId);
      actor = 'SHOP';
    } catch {
      actor = null;
    }
  }
  if (!actor) throw new AppError(404, 'Negotiation not found');
  return { b, actor };
}

// Conditional update: if someone else changed the status first, nothing is written and we return 409.
async function transition(b, data, events) {
  await prisma.$transaction(async (tx) => {
    const changed = await tx.bargain.updateMany({ where: { id: b.id, status: b.status }, data });
    if (changed.count !== 1) {
      throw new AppError(409, 'This negotiation just changed. Refresh and try again.');
    }
    let offset = 0;
    for (const e of events) {
      // explicit, increasing timestamps keep the feed in order
      await tx.bargainEvent.create({
        data: { bargainId: b.id, createdAt: new Date(Date.now() + offset++), ...e },
      });
    }
  });
}

const assertActive = (b) => {
  if (!ACTIVE.includes(effectiveStatus(b))) throw new AppError(409, 'This negotiation is closed');
};

const assertTurn = (b, actor) => {
  if (!isYourTurn(b.status, actor)) throw new AppError(409, 'It is not your turn to respond');
};

export async function getBargain(user, id) {
  const { b, actor } = await loadForActor(user, id);
  return format(b, actor);
}

// Everything the "Make an Offer" modal needs before the customer types a number.
export async function bargainInfo(user, listingId) {
  const listing = await prisma.shopListing.findUnique({
    where: { id: listingId },
    include: { shop: { select: { isActive: true } } },
  });
  if (!listing || !listing.isActive || !listing.shop.isActive) {
    throw new AppError(404, 'Listing not found');
  }
  const { min, max } = offerBounds(listing.price);
  const active = user
    ? await prisma.bargain.findFirst({
        where: {
          listingId,
          customerId: user.id,
          status: { in: LIVE },
          expiresAt: { gt: new Date() },
        },
        select: { id: true, status: true },
      })
    : null;
  return {
    listingId,
    bargainEnabled: listing.bargainEnabled && listing.availability !== 'OUT_OF_STOCK',
    listPrice: listing.price,
    minOffer: min,
    maxOffer: max,
    responseWindowMinutes: env.BARGAIN_TTL_MINUTES,
    activeBargain: active,
  };
}

export async function createBargain(user, { listingId, offer }) {
  const listing = await prisma.shopListing.findUnique({
    where: { id: listingId },
    include: { shop: { select: { ownerId: true, isActive: true } } },
  });
  if (!listing || !listing.isActive || !listing.shop.isActive) {
    throw new AppError(404, 'Listing not found');
  }
  if (listing.shop.ownerId === user.id) {
    throw new AppError(400, 'You cannot bargain in your own shop');
  }
  if (!listing.bargainEnabled) throw new AppError(409, 'This listing does not accept offers');
  if (listing.availability === 'OUT_OF_STOCK') throw new AppError(409, 'This item is out of stock');

  const { min, max } = offerBounds(listing.price);
  if (offer < min || offer > max) {
    throw new AppError(400, `Your offer must be between ${min} and ${max}`);
  }

  const existing = await prisma.bargain.findFirst({
    where: {
      listingId,
      customerId: user.id,
      status: { in: LIVE },
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  });
  if (existing) {
    throw new AppError(409, 'You already have an active negotiation for this item', {
      bargainId: existing.id,
    });
  }

  const auto = meetsShopMinimum(listing, offer);
  const bargain = await prisma.bargain.create({
    data: {
      listingId,
      customerId: user.id,
      listPrice: listing.price,
      currentOffer: offer,
      status: auto ? 'ACCEPTED' : 'AWAITING_SHOP',
      agreedPrice: auto ? offer : null,
      expiresAt: auto ? buyDeadline() : responseDeadline(),
      events: {
        create: [
          { actor: 'CUSTOMER', amount: offer, createdAt: new Date() },
          ...(auto
            ? [
                {
                  actor: 'SYSTEM',
                  note: 'Accepted automatically because the offer meets the shop minimum',
                  createdAt: new Date(Date.now() + 1),
                },
              ]
            : []),
        ],
      },
    },
  });
  return getBargain(user, bargain.id);
}

export async function listMyBargains(user, { status, page, limit }) {
  await expireStaleBargains();
  const where = { customerId: user.id, ...(status && { status }) };
  const [total, rows] = await Promise.all([
    prisma.bargain.count({ where }),
    prisma.bargain.findMany({
      where,
      include: bargainInclude,
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);
  return {
    items: rows.map((b) => summarize(b, 'CUSTOMER')),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

// The shop team's inbox: negotiations on this shop's listings.
export async function listShopBargains(user, shopId, { status, page, limit }) {
  await assertShopAccess(user, shopId);
  await expireStaleBargains();
  const where = { listing: { shopId }, ...(status !== 'ALL' && { status }) };
  const [total, rows] = await Promise.all([
    prisma.bargain.count({ where }),
    prisma.bargain.findMany({
      where,
      include: bargainInclude,
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);
  return {
    items: rows.map((b) => summarize(b, 'SHOP')),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function acceptOffer(user, id) {
  const { b, actor } = await loadForActor(user, id);
  assertActive(b);
  assertTurn(b, actor);
  if (b.listing.availability === 'OUT_OF_STOCK') throw new AppError(409, 'This item is out of stock');

  await transition(
    b,
    { status: 'ACCEPTED', agreedPrice: b.currentOffer, expiresAt: buyDeadline() },
    [{ actor, amount: b.currentOffer, note: 'Accepted' }],
  );
  return getBargain(user, id);
}

export async function counterOffer(user, id, amount) {
  const { b, actor } = await loadForActor(user, id);
  assertActive(b);
  assertTurn(b, actor);

  const offersMade = b.events.filter((e) => e.amount !== null).length;
  if (offersMade >= MAX_OFFERS) {
    throw new AppError(409, 'The maximum number of offers has been reached. Accept or decline.');
  }

  if (actor === 'SHOP') {
    if (amount <= b.currentOffer || amount >= b.listPrice) {
      throw new AppError(400, `Your counter-offer must be above ${b.currentOffer} and below ${b.listPrice}`);
    }
    await transition(b, { status: 'COUNTERED', currentOffer: amount, expiresAt: responseDeadline() }, [
      { actor: 'SHOP', amount },
    ]);
  } else {
    const lastOwn = [...b.events].reverse().find((e) => e.actor === 'CUSTOMER' && e.amount !== null);
    if (amount <= lastOwn.amount || amount >= b.currentOffer) {
      throw new AppError(400, `Your new offer must be above ${lastOwn.amount} and below ${b.currentOffer}`);
    }
    if (meetsShopMinimum(b.listing, amount)) {
      await transition(b, { status: 'ACCEPTED', currentOffer: amount, agreedPrice: amount, expiresAt: buyDeadline() }, [
        { actor: 'CUSTOMER', amount },
        { actor: 'SYSTEM', note: 'Accepted automatically because the offer meets the shop minimum' },
      ]);
    } else {
      await transition(b, { status: 'AWAITING_SHOP', currentOffer: amount, expiresAt: responseDeadline() }, [
        { actor: 'CUSTOMER', amount },
      ]);
    }
  }
  return getBargain(user, id);
}

// The shop may decline only on its turn. The customer may always withdraw while the negotiation is open.
export async function declineOffer(user, id) {
  const { b, actor } = await loadForActor(user, id);
  assertActive(b);
  if (actor === 'SHOP') assertTurn(b, actor);

  const withdrawn = actor === 'CUSTOMER' && !isYourTurn(b.status, actor);
  await transition(b, { status: 'DECLINED' }, [
    { actor, note: withdrawn ? 'Withdrawn' : 'Declined' },
  ]);
  return getBargain(user, id);
}

// Puts ONE unit into the cart with the agreed price attached.
export async function addToCart(user, id) {
  const { b, actor } = await loadForActor(user, id);
  if (actor !== 'CUSTOMER') throw new AppError(403, 'Only the customer can add this to a cart');
  if (effectiveStatus(b) !== 'ACCEPTED') {
    throw new AppError(409, 'Only an accepted offer can be added to the cart');
  }
  const l = b.listing;
  if (!l.isActive || !l.shop.isActive) throw new AppError(409, 'This listing is no longer available');
  if (l.availability === 'OUT_OF_STOCK') throw new AppError(409, 'This item is out of stock');

  const cart = await prisma.cart.upsert({
    where: { userId: user.id },
    update: {},
    create: { userId: user.id },
  });
  await prisma.cartItem.upsert({
    where: { cartId_listingId: { cartId: cart.id, listingId: l.id } },
    update: { quantity: 1, bargainId: b.id },
    create: { cartId: cart.id, listingId: l.id, quantity: 1, bargainId: b.id },
  });
  return getCart(user.id);
}