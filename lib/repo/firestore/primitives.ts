/**
 * The single place (besides the backend aggregate files in this directory)
 * that touches `firebase-admin/firestore`. Everything Firestore-specific —
 * Date↔Timestamp conversion, server timestamps, atomic increment,
 * transactions, retry, deserialization — is funneled through these helpers so
 * it never leaks into `lib/trails/*` or the repository interface.
 */
import { FieldValue, Timestamp, type Transaction } from 'firebase-admin/firestore';
import { adminDB } from '@/lib/firebase/admin';
import { withRetry } from '@/lib/firebase/retry';
import { serializeFirestoreData } from '@/lib/firebase/serialize';

export const db = adminDB;

/** JS Date → Firestore write value. */
export const toTs = (d: Date) => Timestamp.fromDate(d);

/** Server-assigned timestamp (clock-skew-safe; used for createdAt/updatedAt). */
export const serverTs = () => FieldValue.serverTimestamp();

/** Atomic counter delta. */
export const incr = (n: number) => FieldValue.increment(n);

/** Recursive Firestore Timestamp → JS Date on read. */
export const fromFs = serializeFirestoreData;

/**
 * Read-modify-write transaction envelope. Wrapped in a function (rather than a
 * bound reference) so it doesn't touch the lazy `adminDB` proxy at module load.
 */
export const runTx = <T>(updateFn: (tx: Transaction) => Promise<T>): Promise<T> =>
  adminDB.runTransaction<T>(updateFn);

export { withRetry, Timestamp };

// Collection names (decision #4: consistent `trails-*` scheme).
export const SUBSCRIPTIONS_COLLECTION = 'trails-subscriptions';
export const CONVERSATIONS_COLLECTION = 'trails-conversations';
export const NOTIFICATIONS_COLLECTION = 'trails-notifications';
