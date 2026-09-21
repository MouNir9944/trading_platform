/**
 * Long candle history from Binance's 1000-candles-per-request klines endpoint, paging backwards in time.
 * `getKlines(symbol, interval, limit, endTime)` is any client's kline call. Rows are Binance kline arrays.
 */
export async function fetchHistory(getKlines, symbol, interval, total = 3000, { maxPages = 12 } = {}) {
  const byTime = new Map();
  let end;
  for (let page = 0; page < maxPages && byTime.size < total; page++) {
    const want = Math.min(1000, total - byTime.size);
    const rows = await getKlines(symbol, interval, want, end);
    if (!rows?.length) break;
    for (const row of rows) byTime.set(row[0], row);
    end = rows[0][0] - 1;
    if (rows.length < want) break; // reached the start of the pair's history
  }
  return [...byTime.values()].sort((a, b) => a[0] - b[0]);
}
