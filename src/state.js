const DEFAULT_TTL_MS = 10 * 60 * 1000;
const store = new Map();

function gc() {
	const now = Date.now();
	for (const [k, v] of store) {
		if (v.expiresAt <= now) store.delete(k);
	}
}

export function put(key, value, ttlMs = DEFAULT_TTL_MS) {
	gc();
	store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function peek(key) {
	gc();
	const entry = store.get(key);
	return entry ? entry.value : null;
}

export function update(key, mutator, ttlMs = DEFAULT_TTL_MS) {
	gc();
	const entry = store.get(key);
	if (!entry) return null;
	const updated = mutator(entry.value);
	store.set(key, { value: updated, expiresAt: Date.now() + ttlMs });
	return updated;
}

export function remove(key) {
	gc();
	const entry = store.get(key);
	store.delete(key);
	return entry ? entry.value : null;
}

export function take(key) {
	return remove(key);
}

export function newKey() {
	return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}
