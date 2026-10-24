/**
 * Several customers on one node (2026-10-22): each slot's session records carry
 * the prefix `slot<N>/`. Slot 0 keeps the original unprefixed keys, so sessions
 * linked before this change keep working without any migration.
 */
export function slotPrefix(slot) {
  const number = Number(slot) || 0;
  return number > 0 ? `slot${number}/` : '';
}
