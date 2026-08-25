const store = new Map();

const AsyncStorage = {
  async getItem(key) {
    return store.has(key) ? store.get(key) : null;
  },
  async setItem(key, value) {
    store.set(key, String(value));
  },
  async removeItem(key) {
    store.delete(key);
  },
  async clear() {
    store.clear();
  },
  async getAllKeys() {
    return Array.from(store.keys());
  },
  async multiGet(keys) {
    return keys.map((key) => [key, store.has(key) ? store.get(key) : null]);
  },
  async multiSet(entries) {
    for (const [key, value] of entries) {
      store.set(key, String(value));
    }
  },
  async multiRemove(keys) {
    for (const key of keys) {
      store.delete(key);
    }
  },
  async mergeItem(key, value) {
    const existing = store.get(key);
    if (!existing) {
      store.set(key, String(value));
      return;
    }

    try {
      const merged = { ...JSON.parse(existing), ...JSON.parse(String(value)) };
      store.set(key, JSON.stringify(merged));
    } catch {
      store.set(key, String(value));
    }
  },
};

export const {
  getItem,
  setItem,
  removeItem,
  clear,
  getAllKeys,
  multiGet,
  multiSet,
  multiRemove,
  mergeItem,
} = AsyncStorage;

export default AsyncStorage;
