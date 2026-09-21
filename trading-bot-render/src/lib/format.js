/** $1.6T / $320.0B / $88M / $420K */
export function compactMoney(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

export function formatPrice(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (value >= 100) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  if (value >= 0.01) return value.toFixed(5);
  return value.toPrecision(4);
}

/** Compare two market caps: "12× larger" / "3× smaller". */
export function capRatio(cap, reference) {
  if (!(cap > 0) || !(reference > 0)) return null;
  const ratio = cap / reference;
  if (Math.abs(Math.log10(ratio)) < 0.02) return { text: "same", tone: "flat" };
  const times = ratio >= 1 ? ratio : 1 / ratio;
  const text = times >= 100 ? Math.round(times).toLocaleString() : times >= 10 ? times.toFixed(0) : times.toFixed(1);
  return ratio >= 1 ? { text: `${text}× bigger`, tone: "up" } : { text: `${text}× smaller`, tone: "down" };
}

export const splitPair = (symbol, quote = "USDT") => (symbol.endsWith(quote) ? [symbol.slice(0, -quote.length), quote] : [symbol, ""]);
