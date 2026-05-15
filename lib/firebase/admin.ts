import { config } from 'dotenv';
import { cert, getApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

// Load environment variables when this module is imported. Initialization of
// the Firebase app itself is deferred (see below) so that merely importing a
// route — which Next.js does at build time to read its config — does not
// require credentials.
config({ path: '.env.local' });

let _db: Firestore | null = null;
let _app: App | null = null;

function initFirestore(): Firestore {
  if (_db) return _db;

  const decoded = Buffer.from(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 || '',
    'base64'
  ).toString('utf8');
  const serviceAccount = decoded ? JSON.parse(decoded) : undefined;
  if (!serviceAccount || typeof serviceAccount !== 'object') {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 is not set (base64 of the service-account JSON).'
    );
  }

  const alreadyInitialized = getApps().length > 0;
  _app = alreadyInitialized
    ? getApp()
    : initializeApp({
        credential: cert(serviceAccount),
        projectId: serviceAccount.project_id,
      });

  _db = getFirestore(_app);

  // Only configure Firestore settings on first init to avoid "already
  // initialized" errors during hot reloads.
  if (!alreadyInitialized) {
    _db.settings({
      ignoreUndefinedProperties: true,
      // Use REST API instead of gRPC — more reliable on serverless platforms
      // and avoids DEADLINE_EXCEEDED errors from stale gRPC connections.
      preferRest: true,
    });
  }

  return _db;
}

/**
 * Lazily-initialized Firestore handle. Firebase is only initialized on the
 * first actual property access (e.g. `adminDB.collection(...)`), never at
 * module import time — so `next build`'s page-data collection, which imports
 * route modules without invoking handlers, doesn't need credentials.
 */
export const adminDB: Firestore = new Proxy({} as Firestore, {
  get(_target, prop, receiver) {
    const db = initFirestore();
    const value = Reflect.get(db as object, prop, receiver);
    return typeof value === 'function' ? value.bind(db) : value;
  },
});
