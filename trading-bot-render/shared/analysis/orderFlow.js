/**
 * Order flow from candles.
 *
 * Every trade has an aggressor: a buyer who lifts the ask or a seller who hits the bid. Volume bought by aggressive
 * buyers minus volume sold by aggressive sellers is the DELTA: positive means buyers were paying up to get filled,
 * negative means sellers were. Delta that disagrees with price (price falls but delta is positive) shows one side
 * absorbing the other, which is where reversals often start.
 *
 * Binance candles say how much of each candle's volume was bought by aggressive buyers (`takerBuyVolume`), so delta is
 * exact there: delta = buys - sells = 2 * takerBuyVolume - volume. A full footprint (delta at every price) needs trade
 * ticks, which candles do not hold, so this is delta per candle, the best that candles allow.
 *
 * Where the data does not carry it (stocks, other sources) delta is ESTIMATED from where the candle closed inside its
 * own range: a close at the high is read as all buying, at the low as all selling. That is a weaker proxy, and
 * `measured: false` says so, so callers can tell the user which one they got.
 */

/** { delta, ratio, measured } for one candle. `ratio` is delta over volume, from -1 (all selling) to +1 (all buying). */
export function candleFlow(c) {
  const volume = c.volume;
  if (!(volume > 0)) return { delta: 0, ratio: 0, measured: false };
  const buys = c.takerBuyVolume;
  if (Number.isFinite(buys) && buys >= 0 && buys <= volume * 1.0001) {
    const delta = 2 * buys - volume;
    return { delta, ratio: delta / volume, measured: true };
  }
  const range = c.high - c.low;
  const location = range > 0 ? (c.close - c.low - (c.high - c.close)) / range : 0;
  return { delta: volume * location, ratio: location, measured: false };
}

/** Delta of every candle. */
export const flowSeries = (candles) => candles.map(candleFlow);

/** Running total of delta (cumulative volume delta), one value per candle. */
export function cumulativeDelta(candles) {
  let total = 0;
  return candles.map((c) => (total += candleFlow(c).delta));
}
