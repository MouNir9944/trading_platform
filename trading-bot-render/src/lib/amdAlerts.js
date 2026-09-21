/**
 * Delivery helpers for notifications in THIS browser: a chime, and the system notification with its permission.
 * (Deciding what deserves a notification now happens on the server, in server/autoAmd.js, so it works with every tab
 * closed. These helpers only present what the server already decided.)
 *
 * They report their state instead of failing silently: the browser can refuse sound until the page has been clicked,
 * and a system notification needs permission that the user can have blocked.
 */

let audio = null;

/** Create/resume the audio context. Browsers only allow sound after a click; call this from one. */
export function primeAudio() {
  try {
    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctx) return "unsupported";
    audio = audio ?? new Ctx();
    if (audio.state === "suspended") audio.resume();
    return audio.state;
  } catch {
    return "unsupported";
  }
}

/** "running" when a chime would be heard, "blocked" until the page is clicked, "unsupported" without audio. */
export function audioState() {
  if (!audio) return typeof window !== "undefined" && (window.AudioContext ?? window.webkitAudioContext) ? "blocked" : "unsupported";
  return audio.state === "running" ? "running" : "blocked";
}

/** Two rising notes for good news, two falling notes for a warning. Returns false when the browser blocked the sound. */
export function playChime(direction = "up") {
  try {
    if (!audio || audio.state !== "running") return false;
    const notes = direction === "up" ? [660, 880] : [660, 440];
    notes.forEach((freq, i) => {
      const start = audio.currentTime + i * 0.18;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
      osc.connect(gain).connect(audio.destination);
      osc.start(start);
      osc.stop(start + 0.32);
    });
    return true;
  } catch {
    return false;
  }
}

export const desktopSupported = () => typeof window !== "undefined" && "Notification" in window;

/** "granted" | "denied" | "default" (not asked yet) | "unsupported". */
export const desktopPermission = () => (desktopSupported() ? Notification.permission : "unsupported");

/** Ask for permission (call from a click). Returns the resulting permission. */
export async function requestDesktop() {
  if (!desktopSupported()) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function showDesktop(title, body, tag) {
  try {
    if (desktopSupported() && Notification.permission === "granted") {
      new Notification(title, { body, tag });
      return true;
    }
  } catch { /* some browsers only allow notifications from a service worker */ }
  return false;
}
