// Fixed product limits (not environment settings).

// Home page banners in total (active or not), to keep storage small. The public list shows at most this many.
export const MAX_BANNERS = 12;

// Saved listings per customer.
export const MAX_WISHLIST = 200;

// Reserve for pickup: how long the item is held, how long the shop has to confirm,
// and how many reservations a customer may have open at once.
export const RESERVATION_HOURS = 2;
export const RESERVATION_CONFIRM_MINUTES = 30;
export const MAX_ACTIVE_RESERVATIONS = 3;

// Order chat: messages per page, how long after COMPLETED/CANCELLED it stays open,
// and at most one "new message" notification per order and side in this time.
export const CHAT_PAGE = 100;
export const CHAT_OPEN_DAYS_AFTER_CLOSE = 7;
export const CHAT_NOTIFY_EVERY_MS = 5 * 60 * 1000;

// Referral: both sides get this credit (taka) when the referred customer's first order is COMPLETED.
// Credit pays at most this share of an order's items (after a coupon).
export const REFERRAL_CREDIT = 100;
export const CREDIT_MAX_SHARE = 0.2;

// Photos per review.
export const MAX_REVIEW_PHOTOS = 3;

// At most one price-drop notification per wishlist item in this time.
export const PRICE_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
