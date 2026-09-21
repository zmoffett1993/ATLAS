// Private to this browser origin. Contains only account ID and opaque binding, never auth tokens.
export function createBindingStore(indexedDB) {
  async function access(write, value) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("atlas-reminder-device-v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("device");
      request.onerror = () => reject(new Error("Device storage unavailable."));
      request.onsuccess = () => resolve(request.result);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction("device", write ? "readwrite" : "readonly");
        const store = transaction.objectStore("device");
        const request = write ? store.put(value, "current") : store.get("current");
        transaction.oncomplete = () => resolve(request.result ?? null);
        transaction.onabort = transaction.onerror = () => reject(new Error("Device storage unavailable."));
      });
    } finally { db.close(); }
  }
  return { read: () => access(false), write: (value) => access(true, value), clear: () => access(true, null) };
}
