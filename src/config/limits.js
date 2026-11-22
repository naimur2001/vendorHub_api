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

// At most one price-drop notification per wishlist item in this time.
export const PRICE_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
