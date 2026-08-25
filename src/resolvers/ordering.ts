/**
 * Shared result ordering.
 *
 * Collections and documents are both returned newest first. The `id` tiebreak
 * is not cosmetic: timestamps can collide, and without a deterministic second
 * sort key equal rows order arbitrarily, which would let cursor pagination
 * skip or repeat records.
 *
 * Defined once so the two resolvers cannot drift apart - document pagination
 * builds its keyset predicate assuming exactly this ordering.
 */
export const NEWEST_FIRST = [{ createdAt: "desc" }, { id: "desc" }] as const;
