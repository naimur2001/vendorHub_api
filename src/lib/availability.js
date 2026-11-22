// Derives the public availability label from the private stock number.
export function deriveAvailability(stockQty) {
  if (stockQty === null || stockQty === undefined) return 'AVAILABLE';
  if (stockQty === 0) return 'OUT_OF_STOCK';
  if (stockQty <= 5) return 'LIMITED';
  return 'IN_STOCK';
}

// Not low any more (restocked above lowStockAt, no number tracked, or the alert is off):
// a listing in this state may send the next low-stock notification.
export const stockIsFine = (l) => l.stockQty === null || l.lowStockAt === null || l.stockQty > l.lowStockAt;