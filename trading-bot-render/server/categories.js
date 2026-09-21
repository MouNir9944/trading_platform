/**
 * Asset classes. Binance has no separate "stocks" or "forex" products; these are ordinary instruments that
 * we group so they are easy to find:
 *
 *  - stock:     tokenized stocks on SPOT (TSLAB/USDT, NVDAB/USDT, ...) and equity/ETF perpetuals on FUTURES
 *  - commodity: gold, silver, platinum, copper, oil, gas (futures)
 *  - forex:     fiat currency pairs against USDT (EUR/USDT on spot). Binance is not a forex broker.
 *  - index:     index contracts (futures)
 *  - premarket: pre-launch / pre-IPO contracts (futures)
 *  - crypto:    everything else
 */

export const CATEGORIES = ["crypto", "stock", "commodity", "forex", "other"];

// Fiat currencies that appear as the BASE of a USDT pair on Binance spot.
const FIAT = new Set(["EUR", "GBP", "AUD", "TRY", "BRL", "ARS", "PLN", "RON", "UAH", "ZAR", "MXN", "COP", "CZK", "JPY", "NGN", "RUB", "IDR", "THB", "KZT", "AED", "USD"]);

// Used only if the futures list (which names every listed stock) cannot be fetched.
const FALLBACK_EQUITIES = ["AAPL", "TSLA", "NVDA", "MSFT", "AMZN", "GOOGL", "META", "SPY", "QQQ", "MSTR", "COIN", "HOOD", "CRCL", "PLTR", "INTC", "PYPL", "TSM", "MU"];

/** Futures underlying type -> category. */
export function categorizeFutures(info) {
  switch (info.underlyingType) {
    case "EQUITY":
    case "KR_EQUITY":
    case "HK_EQUITY":
    case "CN_EQUITY":
      return "stock";
    case "COMMODITY":
      return "commodity";
    case "FX":
      return "forex";
    case "INDEX":
    case "PREMARKET":
      return "other";
    default:
      return "crypto";
  }
}

/** Base assets of every listed stock contract, e.g. Set{"TSLA","AAPL",...}. */
export function equityBasesFrom(futuresInfo) {
  const bases = new Set(FALLBACK_EQUITIES);
  for (const s of futuresInfo?.symbols ?? []) if (categorizeFutures(s) === "stock") bases.add(s.baseAsset);
  return bases;
}

/**
 * Spot category. Tokenized stocks are listed as <TICKER>B (TSLAB, NVDAB), so a base that ends in "B" and whose
 * remainder is a listed stock ticker is a stock token.
 */
export function categorizeSpot(base, quote, equityBases) {
  if (quote === "USDT" && FIAT.has(base)) return "forex";
  if (base.length > 2 && base.endsWith("B") && equityBases.has(base.slice(0, -1))) return "stock";
  return "crypto";
}

/** Category label for the UI. */
export const CATEGORY_LABELS = { crypto: "Crypto", stock: "Stocks", commodity: "Commodities", forex: "Forex", other: "Other" };
