// Derives the public availability label from the private stock number.
export function deriveAvailability(stockQty) {
  if (stockQty === null || stockQty === undefined) return 'AVAILABLE';
  if (stockQty === 0) return 'OUT_OF_STOCK';
  if (stockQty <= 5) return 'LIMITED';
  return 'IN_STOCK';
}