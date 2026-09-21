import { useEffect, useState } from "react";

/**
 * useState that survives a refresh: the value is read from localStorage on first render and written back on every
 * change. `valid(value)` rejects a stored value that no longer makes sense (an option that was removed, a corrupted
 * entry) and falls back to `initial`. Storage being blocked or full never breaks the page; it just stops saving.
 */
export function usePersistentState(key, initial, valid) {
  const [value, setValue] = useState(() => {
    const fallback = typeof initial === "function" ? initial() : initial;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return fallback;
      const parsed = JSON.parse(raw);
      if (valid && !valid(parsed)) return fallback;
      // Objects are merged over the defaults so a setting added later still gets its default.
      if (fallback && parsed && typeof fallback === "object" && !Array.isArray(fallback) && typeof parsed === "object") {
        return { ...fallback, ...parsed };
      }
      return parsed;
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  }, [key, value]);

  return [value, setValue];
}

export const oneOf = (options) => (value) => options.includes(value);
export const numberIn = (min, max) => (value) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
/** Form fields are kept as strings; accept only text so a bad entry can't reach an input. */
export const isText = (value) => typeof value === "string";
