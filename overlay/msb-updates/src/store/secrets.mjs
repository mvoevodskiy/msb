export function createSecretBox() {
  const box = new Map();
  return {
    put(key, value) {
      box.set(String(key), value);
    },
    peek(key) {
      return box.get(String(key)) || null;
    },
    drop(key) {
      box.delete(String(key));
    },
  };
}
