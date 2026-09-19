/**
 * Exact decimal helpers for exchange tick/step sizes. Binance rejects orders whose
 * price/quantity aren't a multiple of the step, so float arithmetic isn't safe here.
 */

/** Expand a number into a plain decimal string (no exponent notation). */
export function plainString(value) {
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(text);
  if (!match) return text;
  const [, sign, int, frac = "", exp] = match;
  const digits = int + frac;
  const point = int.length + Number(exp);
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

function decimalsOf(value) {
  return (plainString(value).split(".")[1] ?? "").length;
}

/** Parse a number into an integer count of 10^-scale units, truncating toward zero. */
function toScaled(value, scale) {
  const text = plainString(Math.abs(value));
  const [int, frac = ""] = text.split(".");
  const scaled = BigInt(int + frac.padEnd(scale, "0").slice(0, scale));
  return value < 0 ? -scaled : scaled;
}

function fromScaled(scaled, scale) {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(scale + 1, "0");
  const text = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return Number(negative ? `-${text}` : text);
}

/** Round `value` toward zero to a whole multiple of `step` (mirrors Decimal ROUND_DOWN). */
export function formatDecimal(value, step) {
  const scale = Math.max(decimalsOf(value), decimalsOf(step));
  const stepScaled = toScaled(step, scale);
  if (stepScaled === 0n) return value;
  const valueScaled = toScaled(value, scale);
  return fromScaled((valueScaled / stepScaled) * stepScaled, scale);
}

/** Number → plain decimal string for the Binance API. */
export const decimalString = plainString;
