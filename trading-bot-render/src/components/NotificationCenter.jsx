import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { getNotifications, markNotificationsRead } from "../api.js";
import { audioState, desktopPermission, playChime, primeAudio, requestDesktop, showDesktop } from "../lib/amdAlerts.js";

const POLL_MS = 10_000;
const LOUD = new Set(["test", "signal", "order", "filled", "closed", "error", "cancelled", "armed"]); // shown as a card; the rest only in the list
const ICON = { success: "●", warn: "▲", error: "✕", info: "•" };

const PREFS_KEY = "notify-prefs";
function loadPrefs() {
  try { return { sound: true, desktop: false, ...JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? "{}") }; } catch { return { sound: true, desktop: false }; }
}

const clock = (ms, timeZone) => new Intl.DateTimeFormat(undefined, { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);

/** How to fix a blocked system notification, in the words of the person looking at a browser. */
export const PERMISSION_HELP = {
  granted: "Allowed: system notifications appear even when this tab is in the background.",
  default: "Not asked yet: turn it on below and the browser will ask you.",
  denied: "Blocked by your browser. Click the lock icon in the address bar, set Notifications to Allow, then reload this page.",
  unsupported: "This browser cannot show system notifications.",
};

/**
 * The bell and the cards. Everything comes from the server, which watches the markets whether or not this page is
 * open: anything that happened while you were away is waiting here as unread. Poll every 10 seconds; new events
 * become cards, a chime and (if allowed) a system notification.
 */
export default function NotificationCenter({ timeZone = "UTC", onUsePlan = () => {}, onOpenSettings = () => {} }) {
  const [events, setEvents] = useState([]);
  const [unread, setUnread] = useState(0);
  const [cards, setCards] = useState([]);
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState(loadPrefs);
  const [permission, setPermission] = useState(desktopPermission);
  const [sound, setSound] = useState(audioState);
  const [error, setError] = useState(null);
  const lastAt = useRef(null);
  const prefsRef = useRef(prefs);
  const rootRef = useRef(null);
  const bellRef = useRef(null);
  const panelRef = useRef(null);
  prefsRef.current = prefs;

  // The panel is fixed to the viewport's right edge (not positioned off the bell) so it always opens from the
  // right side of the screen, whatever row of a wrapped header the bell itself lands on. Only its vertical
  // position (how far below the bell to hang) still depends on where the bell actually is.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const bell = bellRef.current;
    const panel = panelRef.current;
    if (!bell || !panel) return undefined;
    function place() {
      panel.style.top = `${bell.getBoundingClientRect().bottom + 8}px`;
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  const poll = useCallback(async () => {
    try {
      const first = lastAt.current == null;
      const data = await getNotifications(first ? 0 : lastAt.current, first ? 40 : 100);
      setError(null);
      setUnread(data.unread);
      if (first) {
        lastAt.current = data.events[0]?.at ?? 0;
        setEvents(data.events);
        const away = data.events.filter((e) => !e.read && LOUD.has(e.type));
        if (away.length) {
          setCards([{ key: "away", level: "info", title: `${away.length} notification${away.length === 1 ? "" : "s"} while you were away`, body: away.slice(0, 3).map((e) => e.title).join(" · "), away: true }]);
        }
        return;
      }
      const fresh = data.events.filter((e) => e.at > lastAt.current);
      if (!fresh.length) return;
      lastAt.current = Math.max(...fresh.map((e) => e.at));
      setEvents((previous) => [...fresh, ...previous].slice(0, 60));
      const loud = fresh.filter((e) => LOUD.has(e.type)).reverse();
      if (loud.length) {
        setCards((previous) => [...loud.map((e) => ({ key: e.id, ...e })).reverse(), ...previous].slice(0, 4));
        const pitch = loud.some((e) => e.level === "error" || e.level === "warn") && !loud.some((e) => e.type === "signal" && e.dir === "bull") ? "down" : "up";
        if (prefsRef.current.sound) setSound(playChime(pitch) ? "running" : audioState());
        if (prefsRef.current.desktop) for (const e of loud.slice(0, 3)) showDesktop(e.title, e.body ?? "", e.id);
      }
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    poll();
    const id = window.setInterval(poll, POLL_MS);
    // browsers allow sound only after a click: the first click anywhere on the page unlocks it
    const unlock = () => setSound(primeAudio());
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => { window.clearInterval(id); window.removeEventListener("pointerdown", unlock); };
  }, [poll]);

  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); window.removeEventListener("keydown", key); };
  }, [open]);

  useEffect(() => {
    try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable */ }
  }, [prefs]);

  const markAll = async () => {
    try {
      await markNotificationsRead();
      setUnread(0);
      setEvents((previous) => previous.map((e) => ({ ...e, read: true })));
    } catch (err) {
      setError(err.message);
    }
  };

  const turnOnSystem = async () => {
    const result = await requestDesktop();
    setPermission(result);
    setPrefs((p) => ({ ...p, desktop: result === "granted" }));
  };

  const dismiss = (key) => setCards((previous) => previous.filter((c) => c.key !== key));
  const canUse = (c) => c.plan && c.symbol && (c.type === "signal" || c.type === "order");

  return (
    <>
      <div className="notif-wrap" ref={rootRef}>
        <button type="button" ref={bellRef} className={`notif-bell${unread ? " has-unread" : ""}`} aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} aria-expanded={open} onClick={() => setOpen((v) => !v)} title="Notifications from the AMD bot">
          <span aria-hidden="true">🔔</span>
          {unread > 0 && <b>{unread > 99 ? "99+" : unread}</b>}
        </button>
        {open && (
          <div className="notif-panel" role="dialog" aria-label="Notifications" ref={panelRef}>
            <div className="notif-head">
              <strong>Notifications</strong>
              <div>
                <button type="button" className="link-button" onClick={markAll} disabled={!unread}>Mark all read</button>
                <button type="button" className="link-button" onClick={() => { setOpen(false); onOpenSettings(); }}>Settings</button>
              </div>
            </div>
            {error && <p className="notif-note is-error">Could not reach the server: {error}</p>}
            <div className="notif-prefs">
              <label className="switch"><input type="checkbox" checked={prefs.sound} onChange={(e) => { setSound(primeAudio()); setPrefs((p) => ({ ...p, sound: e.target.checked })); }} /> Sound</label>
              <label className="switch" title={PERMISSION_HELP[permission]}>
                <input type="checkbox" checked={prefs.desktop && permission === "granted"} onChange={(e) => (e.target.checked ? turnOnSystem() : setPrefs((p) => ({ ...p, desktop: false })))} disabled={permission === "denied" || permission === "unsupported"} /> System notification
              </label>
            </div>
            {prefs.sound && sound === "blocked" && <p className="notif-note">Sound is blocked by your browser until you click on the page once. Click anywhere, then it works.</p>}
            {permission === "denied" && <p className="notif-note is-error">{PERMISSION_HELP.denied}</p>}
            <div className="notif-list">
              {events.length === 0 && <p className="log-empty">Nothing yet. When the AMD bot sees a signal or acts on one, it appears here.</p>}
              {events.slice(0, 30).map((e) => (
                <div className={`notif-item is-${e.level}${e.read ? " is-read" : ""}`} key={e.id}>
                  <i aria-hidden="true">{ICON[e.level] ?? "•"}</i>
                  <div>
                    <p className="notif-title">{e.title}</p>
                    {e.body && <p className="notif-body">{e.body}</p>}
                    <p className="notif-time">{clock(e.at, timeZone)}{e.delivery && Object.keys(e.delivery).length ? ` · ${Object.entries(e.delivery).map(([k, v]) => `${k}: ${v}`).join(" · ")}` : ""}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {cards.length > 0 && (
        <div className="amd-toasts" role="region" aria-label="New notifications">
          {cards.map((c) => (
            <div key={c.key} className={`amd-toast ${c.level === "error" ? "is-exit" : c.level === "warn" ? "is-warn" : "is-buy"}`} role="alert">
              <div className="amd-toast-head">
                <strong>{c.title}</strong>
                <button type="button" onClick={() => dismiss(c.key)} aria-label="Dismiss">×</button>
              </div>
              {c.body && <p>{c.body}</p>}
              <div className="amd-toast-actions">
                {canUse(c) && <button type="button" className="mini-button" onClick={() => { onUsePlan(c); dismiss(c.key); }}>Use in order ticket</button>}
                {c.away && <button type="button" className="mini-button" onClick={() => { dismiss(c.key); setOpen(true); }}>Open</button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
