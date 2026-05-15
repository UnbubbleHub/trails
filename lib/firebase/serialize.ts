// Helper function to serialize Firestore data for client components
export function serializeFirestoreData<T>(data: any): T {
  if (data === null || data === undefined) {
    return data;
  }

  if (data.toDate && typeof data.toDate === 'function') {
    // Firestore Timestamp -> Date
    return data.toDate() as T;
  }

  if (Array.isArray(data)) {
    return data.map((item) => serializeFirestoreData(item)) as T;
  }

  if (typeof data === 'object') {
    const serialized: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      serialized[key] = serializeFirestoreData(value);
    }
    return serialized as T;
  }

  return data;
}
