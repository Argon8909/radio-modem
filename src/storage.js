let database;
function open() {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('radiobridge', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', { keyPath: 'key', autoIncrement: true });
      if (!db.objectStoreNames.contains('reliable')) db.createObjectStore('reliable');
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
    request.onerror = () => { database = undefined; reject(request.error); };
    request.onblocked = () => { database = undefined; reject(new Error('Закройте другие вкладки RadioBridge для обновления хранилища.')); };
  });
}
async function transaction(mode, action, storeName = 'messages') {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = action(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export const readMessages = () => transaction('readonly', store => store.getAll());
export const saveMessage = message => transaction('readwrite', store => store.add(message));
export const clearMessages = () => transaction('readwrite', store => store.clear());
// A receiver checkpoint and its completed flag commit atomically before ACK.
export const reliableStore = {
  load: device => transaction('readonly', store => store.get(device), 'reliable'),
  save: (device, state) => transaction('readwrite', store => store.put(state, device), 'reliable')
};
