import { useEffect, useRef, useState } from "react";

import { getFavorites, saveFavorites } from "../api.js";
import { usePersistentState } from "./persist.js";

const isMap = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const SAVE_DELAY_MS = 400;

/**
 * A favorites map ("pairs" or "stocks") with the same [value, setValue] shape as usePersistentState.
 *
 * The map is kept in this browser (so it paints instantly and survives the server being unreachable) and mirrored to
 * the server, which is where the Telegram agent and the MCP tools read it and where your other devices get it from.
 *
 * On first load the server's list and this browser's list are merged (the server wins when both have the same entry),
 * so favorites saved here before the server kept any move over by themselves. If the server cannot be reached, edits
 * stay local and `error` says so: nothing is ever pushed over the server's copy until it has been read once.
 */
export function useFavorites(kind, localKey) {
  const [value, setValue] = usePersistentState(localKey, {}, isMap);
  const [error, setError] = useState(null);
  const latest = useRef(value);
  const loaded = useRef(false);
  const timer = useRef(null);

  const push = () => {
    timer.current = null;
    saveFavorites(kind, latest.current).then(() => setError(null)).catch((err) => setError(err.message));
  };

  useEffect(() => {
    let cancelled = false;
    getFavorites()
      .then((all) => {
        if (cancelled) return;
        const remote = isMap(all?.[kind]) ? all[kind] : {};
        const merged = { ...latest.current, ...remote };
        latest.current = merged;
        setValue(merged);
        loaded.current = true;
        setError(null);
        if (Object.keys(merged).length > Object.keys(remote).length) push(); // local-only entries move to the server
      })
      .catch((err) => { if (!cancelled) setError(`Not synced: ${err.message}`); });
    return () => {
      cancelled = true;
      if (timer.current) { window.clearTimeout(timer.current); push(); } // do not lose an edit made just before leaving
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const update = (next) => {
    const resolved = typeof next === "function" ? next(latest.current) : next;
    latest.current = resolved;
    setValue(resolved);
    if (!loaded.current) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(push, SAVE_DELAY_MS);
  };

  return [value, update, { error }];
}
