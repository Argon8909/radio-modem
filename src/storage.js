let database;
function open() {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('radiobridge', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('messages', { keyPath: 'key', autoIncrement: true });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transaction(mode, action) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', mode);
    const request = action(tx.objectStore('messages'));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export const readMessages = () => transaction('readonly', store => store.getAll());
export const saveMessage = message => transaction('readwrite', store => store.add(message));
export const clearMessages = () => transaction('readwrite', store => store.clear());
