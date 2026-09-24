import { useEffect, useMemo, useRef, useState } from "react";

import { capRatio, compactMoney, formatPrice, splitPair } from "../lib/format.js";
import { usePersistentState, oneOf } from "../lib/persist.js";

const CATEGORY_CHIPS = [
  ["all", "All"],
  ["crypto", "Crypto"],
  ["stock", "Stocks"],
  ["commodity", "Commodities"],
  ["forex", "Forex"],
  ["other", "Other"],
];
const CATEGORY_NOTES = {
  stock: "Stocks follow their home market: prices move little while it is closed (nights and weekends), and moves can gap when it reopens.",
  forex: "Binance is not a forex broker: EUR/USDT is the only currency pair listed against USDT on spot.",
  commodity: "Commodity contracts track the underlying futures price and can be closed or thin outside their home trading hours.",
};

const SORTS = [
  ["score", "Best to trade"],
  ["marketCap", "Market cap"],
  ["quoteVolume", "Volume"],
  ["change24h", "24h move"],
];

const SORT_FNS = {
  score: (a, b) => (b.score ?? -1) - (a.score ?? -1) || b.quoteVolume - a.quoteVolume,
  marketCap: (a, b) => (b.marketCap ?? -1) - (a.marketCap ?? -1),
  quoteVolume: (a, b) => b.quoteVolume - a.quoteVolume,
  change24h: (a, b) => b.change24h - a.change24h,
};

/**
 * Pair selector for the header. Opens a searchable table that compares every tradable pair:
 * price, 24h move, volume, market cap (with a bar and "× bigger/smaller than the current pair"),
 * and a score for how good the pair is to trade right now.
 */
export default function PairPicker({ symbol, price, priceDirection, overview, market = "spot", onMarketChange = () => {}, onSelect }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = usePersistentState("pref:pair-picker-sort", "score", oneOf(Object.keys(SORT_FNS)));
  const [category, setCategory] = usePersistentState("pref:pair-picker-category", "all", oneOf(CATEGORY_CHIPS.map(([id]) => id)));
  const rootRef = useRef(null);
  const searchRef = useRef(null);

  const rows = overview?.pairs ?? [];
  const futures = market === "futures";
  const current = rows.find((row) => row.symbol === symbol) ?? null;
  const [base, quote] = splitPair(symbol);

  useEffect(() => {
    if (!open) return undefined;
    searchRef.current?.focus();
    const onDown = (event) => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
    const onKey = (event) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // The category filter resets when you switch between Spot and Futures.
  useEffect(() => setCategory("all"), [market]);
  const counts = useMemo(() => rows.reduce((m, r) => ((m[r.category] = (m[r.category] ?? 0) + 1), m), {}), [rows]);
  const inCategory = useMemo(() => (category === "all" ? rows : rows.filter((r) => r.category === category)), [rows, category]);
  const best = useMemo(() => inCategory.filter((r) => r.score != null).slice(0, 3), [inCategory]);
  const maxCap = useMemo(() => Math.max(1, ...rows.map((r) => r.marketCap ?? 0)), [rows]);
  const visible = useMemo(() => {
    const q = query.trim().toUpperCase();
    return inCategory
      .filter((r) => !q || r.symbol.includes(q))
      .sort(SORT_FNS[sort])
      .slice(0, 250);
  }, [inCategory, query, sort]);

  const pick = (next) => {
    setOpen(false);
    setQuery("");
    if (next !== symbol) onSelect(next);
  };

  return (
    <div className="pair-picker" ref={rootRef}>
      <div className="pair-block">
        <button type="button" className="pair-trigger" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)} title="Choose a pair and compare markets">
          <span className="pair-name">{base}<em>/{quote}</em></span>
          {futures && <span className="cat-badge cat-perp">PERP</span>}
          {current && current.category !== "crypto" && <span className={`cat-badge cat-${current.category}`}>{categoryLabel(current.category)}</span>}
          <span className="chev" aria-hidden="true">▾</span>
        </button>
        <span className={`pair-price ${priceDirection ? `tick-${priceDirection}` : ""}`}>{price != null ? formatPrice(price) : "—"}</span>
      </div>

      {current && (
        <div className="pair-chips">
          <span className="chip" title="Market capitalisation and rank">MCap <b>{compactMoney(current.marketCap)}</b>{current.marketCapRank ? <em>#{current.marketCapRank}</em> : null}</span>
          <span className="chip" title="24h traded volume">Vol <b>{compactMoney(current.quoteVolume)}</b></span>
          {current.score != null && (
            <button type="button" className={`chip chip-score ${scoreTone(current.score)}`} onClick={() => setOpen(true)} title="How good this pair looks to trade right now. Click to compare.">
              Score <b>{current.score}</b><em>#{current.scoreRank} of {rows.filter((r) => r.score != null).length}</em>
            </button>
          )}
        </div>
      )}

      {open && (
        <div className="pair-menu" role="dialog" aria-label="Choose a pair">
          <div className="pm-markets" role="tablist" aria-label="Market">
            <button type="button" role="tab" aria-selected={!futures} className={!futures ? "is-active" : ""} onClick={() => onMarketChange("spot")}>Spot <small>tradable</small></button>
            <button type="button" role="tab" aria-selected={futures} className={futures ? "is-active" : ""} onClick={() => onMarketChange("futures")}>Futures <small>leverage</small></button>
          </div>
          {rows.length > 0 && (
            <div className="pm-cats" role="group" aria-label="Asset class">
              {CATEGORY_CHIPS.filter(([key]) => key === "all" || counts[key]).map(([key, label]) => (
                <button key={key} type="button" className={category === key ? "is-on" : ""} onClick={() => setCategory(key)}>
                  {label}<em>{key === "all" ? rows.length : counts[key]}</em>
                </button>
              ))}
            </div>
          )}
          {CATEGORY_NOTES[category] && <p className="pm-note">{CATEGORY_NOTES[category]}</p>}
          <div className="pm-head">
            <input ref={searchRef} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search a coin (BTC, SOL…)" aria-label="Search pairs" />
            <div className="segmented segmented-small" role="group" aria-label="Sort pairs">
              {SORTS.map(([key, label]) => (
                <button key={key} type="button" className={sort === key ? "is-active" : ""} onClick={() => setSort(key)}>{label}</button>
              ))}
            </div>
          </div>

          {!overview && <p className="pm-empty">Loading market data…</p>}

          {best.length > 0 && !query && (
            <div className="pm-best">
              <h4>{category === "all" ? "Best pairs to trade right now" : `Best ${categoryLabel(category).toLowerCase()} to trade right now`}</h4>
              <div className="pm-best-grid">
                {best.map((r, i) => (
                  <button key={r.symbol} type="button" className="pm-best-card" onClick={() => pick(r.symbol)}>
                    <span className="pm-rank">#{i + 1}</span>
                    <strong>{r.base}<em>/USDT</em></strong>
                    <span className={`score-pill ${scoreTone(r.score)}`}>{r.score}</span>
                    <small>{r.reasons[0] ?? "Balanced liquidity and range"}</small>
                  </button>
                ))}
              </div>
            </div>
          )}

          {overview && (
            <div className="pm-table" role="listbox" aria-label="Pairs">
              <div className="pm-row pm-header" aria-hidden="true">
                <span>Pair</span><span>Price</span><span>24h</span><span>Volume</span><span>Market cap</span><span>vs {base}</span><span>Score</span>
              </div>
              {visible.length === 0 && <p className="pm-empty">No pair matches “{query}”.</p>}
              {visible.map((r) => {
                const ratio = r.symbol === symbol ? null : capRatio(r.marketCap, current?.marketCap);
                return (
                  <button
                    key={r.symbol}
                    type="button"
                    role="option"
                    aria-selected={r.symbol === symbol}
                    className={`pm-row ${r.symbol === symbol ? "is-current" : ""}`}
                    onClick={() => pick(r.symbol)}
                    title={[...r.reasons, ...r.warnings].join(" · ") || undefined}
                  >
                    <span className="pm-pair">{r.base}<em>/USDT</em>{r.category !== "crypto" && <i className={`cat-badge cat-${r.category}`}>{categoryLabel(r.category)}</i>}</span>
                    <span className="pm-num">{formatPrice(r.price)}</span>
                    <span className={`pm-num ${r.change24h >= 0 ? "profit-estimate" : "loss-estimate"}`}>{r.change24h >= 0 ? "+" : ""}{r.change24h.toFixed(1)}%</span>
                    <span className="pm-num">{compactMoney(r.quoteVolume)}</span>
                    <span className="pm-cap">
                      <b>{compactMoney(r.marketCap)}</b>
                      {r.marketCap > 0 && <i style={{ width: `${Math.max(3, (Math.log10(r.marketCap) / Math.log10(maxCap)) * 100)}%` }} />}
                    </span>
                    <span className={`pm-ratio ${ratio ? `tag-${ratio.tone}` : ""}`}>{r.symbol === symbol ? "current" : ratio ? ratio.text : "—"}</span>
                    <span>{r.score == null ? <em className="pm-na" title="Too little trading volume to score">n/a</em> : <b className={`score-pill ${scoreTone(r.score)}`}>{r.score}</b>}</span>
                  </button>
                );
              })}
            </div>
          )}

          <p className="pm-foot">
            {overview
              ? <>
                  {futures ? "Live Binance USD-M futures market data" : overview.source === "live" ? "Live Binance market data" : "This account's market data (live data unavailable)"}
                  {overview.marketCapAvailable ? " · market caps from CoinGecko" : " · market caps unavailable right now"}
                  {" · "}Updated {new Date(overview.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.
                </>
              : null}
            {" "}The score (0–100) weighs liquidity 35%, spread 20%, a 24h range of 2–8% 25%, activity 10% and size 10%.
            It is a screening aid built from market data, not advice or a prediction.
          </p>
        </div>
      )}
    </div>
  );
}

function scoreTone(score) {
  return score >= 75 ? "score-high" : score >= 50 ? "score-mid" : "score-low";
}

function categoryLabel(category) {
  return { crypto: "Crypto", stock: "Stock", commodity: "Commodity", forex: "Forex", other: "Other" }[category] ?? category;
}
