// Fixed product limits (not environment settings).

// Home page banners in total (active or not), to keep storage small. The public list shows at most this many.
export const MAX_BANNERS = 12; // HERO + SIDE_AD together
export const MAX_GALLERY_IMAGES = 16; // GALLERY has its own limit

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

// Admin order monitor: when an order counts as late.
export const LATE_UNCONFIRMED_HOURS = 2; // PLACED and not confirmed (a reservation: after its confirmBy)
export const LATE_DELIVERY_HOURS = 48; // OUT_FOR_DELIVERY for longer
export const LATE_PICKUP_DAYS = 3; // READY_FOR_PICKUP for longer
export const SHOP_REMINDER_EVERY_MS = 60 * 60 * 1000; // one "order is late" reminder per order per hour
export const ADMIN_NOTE_MAX = 500;

// Shop To-Let.
export const TOLET_PUBLISH_DAYS = 60; // a published listing expires after this (renew adds the same)
export const TOLET_REMIND_DAYS = 5; // the owner is reminded this many days before it expires
export const TOLET_MAX_OPEN = 3; // open listings per phone or email
export const TOLET_MAX_PHOTOS = 6;
export const TOLET_MAX_DOCUMENTS = 3;
export const TOLET_EMAIL_HOURS = 24; // the confirmation link works this long
export const TOLET_INQUIRIES_PER_DAY = 3; // per phone
export const TOLET_MESSAGE_MAX = 1000;

// Product deletion requests.
export const PRODUCT_DELETION_HOURS = 12; // a PENDING request is carried out this long after it was made
export const PRODUCT_DELETION_REASON_MAX = 500;

// Courier delivery.
export const COURIER_RETRY_MINUTES = [1, 5]; // a failed booking is tried again after these waits (3 tries in all)
export const COURIER_MAX_BOOKING_TRIES = 3;
export const COURIER_BOOKING_CLAIM_MS = 2 * 60 * 1000; // a booking that started longer ago than this is free again
export const COURIER_LOCATIONS_CACHE_MS = 24 * 60 * 60 * 1000;
export const SHIPMENT_STUCK_HOURS = 48; // an active shipment with no update for longer is flagged "stuck"
export const SHIPMENT_POLL_MINUTES = 30;
