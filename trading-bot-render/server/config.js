import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(here, "..");
// On Render, point DATA_DIR at a persistent disk mount (e.g. /var/data) so
// orders and settings survive restarts and redeploys.
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, "data"));
fs.mkdirSync(DATA_DIR, { recursive: true });

export const dataPath = (name) => path.join(DATA_DIR, name);

export const MODES = ["paper", "live"];

export function assertMode(mode) {
  if (!MODES.includes(mode)) throw new Error("Mode must be paper or live");
  return mode;
}

/** Write via a temp file + rename so a crash mid-write can't corrupt the store. */
export function writeFileSafe(file, contents) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, contents, "utf-8");
  fs.renameSync(tmp, file);
}
