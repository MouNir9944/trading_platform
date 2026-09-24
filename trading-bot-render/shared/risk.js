/**
 * Risk management rules. Pure functions shared by the server (which ENFORCES them when an order is
 * placed) and the browser (which previews them), so both always agree.
 *
 * Vocabulary
 *  - capital:    what the limits are measured against (account equity in the quote asset, or a fixed amount)
 *  - risk:       money lost if the stop-loss fills, fees included (the app's estimated_loss_usdt)
 *  - open risk:  total risk across orders that are waiting or in a position ("portfolio heat")
 *  - R:R:        reward-to-risk ratio of the trade
 */

export const RISK_DEFAULTS = Object.freeze({
  enabled: true, // master switch for the limits below (the pause switch always applies)
  paused: false, // manual kill switch: no new orders while true
  capitalMode: "auto", // "auto" = account equity, "fixed" = fixedCapital
  fixedCapital: 1000,
  riskPerTradePct: 1, // max % of capital lost if one stop-loss fills
  maxPositionPct: 25, // max % of capital in a single position
  maxOpenRiskPct: 3, // max total % of capital at risk across open orders
  maxDailyLossPct: 3, // stop for the (UTC) day once net P&L is this far below zero
  maxLossStreak: 3, // consecutive losing trades that trigger a cooldown
  cooldownMinutes: 60,
  minRewardRisk: 1.5, // reject trades whose target is closer than this multiple of the risk
  maxDrawdownPct: 10, // halt when equity falls this far from its realized peak
  maxLeverage: 5, // futures only: highest leverage an order may use
  drawdownResetAt: null, // ISO time: drawdown is measured from trades closed after this
});

const RANGES = {
  fixedCapital: [1, 1e9],
  riskPerTradePct: [0.05, 10],
  maxPositionPct: [1, 100],
  maxOpenRiskPct: [0.1, 50],
  maxDailyLossPct: [0.1, 50],
  maxLossStreak: [1, 20, true],
  cooldownMinutes: [0, 1440, true],
  minRewardRisk: [0, 10],
  maxDrawdownPct: [1, 90],
  maxLeverage: [1, 20, true],
};

/** Validate a (partial) settings object. Throws a readable Error on bad input; returns the merged result. */
export function normalizeSettings(patch, current = RISK_DEFAULTS) {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!(key in RISK_DEFAULTS)) throw new Error(`Unknown risk setting: ${key}`);
    if (key === "enabled" || key === "paused") {
      if (typeof value !== "boolean") throw new Error(`${key} must be true or false`);
      next[key] = value;
    } else if (key === "capitalMode") {
      if (value !== "auto" && value !== "fixed") throw new Error("capitalMode must be auto or fixed");
      next[key] = value;
    } else if (key === "drawdownResetAt") {
      if (value !== null && !Number.isFinite(Date.parse(value))) throw new Error("drawdownResetAt must be a date or null");
      next[key] = value;
    } else {
      const [min, max, integer] = RANGES[key];
      const n = Number(value);
      if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${key} must be between ${min} and ${max}`);
      if (integer && !Number.isInteger(n)) throw new Error(`${key} must be a whole number`);
      next[key] = n;
    }
  }
  return next;
}

const MAINTENANCE_MARGIN_PCT = 0.5; // approximate maintenance margin rate of the smallest position tier
const LIQUIDATION_BUFFER = 0.8; // the stop must sit inside 80% of the distance to liquidation

const OPEN = new Set(["WAITING_ENTRY", "PROTECTED", "MODIFYING"]);
const round2 = (n) => Math.round(n * 100) / 100;
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Account equity the limits are measured against. `null` when it cannot be determined yet. */
export function computeCapital(settings, { quoteTotal = null, orders = [] } = {}) {
  if (settings.capitalMode === "fixed") return settings.fixedCapital;
  if (quoteTotal == null) return null;
  // Money already spent on filled positions is no longer in the quote balance but is still ours.
  const inPositions = orders.filter((o) => o.status === "PROTECTED").reduce((sum, o) => sum + (Number(o.capital_usdt) || 0), 0);
  return quoteTotal + inPositions;
}

function closedTrades(orders) {
  return orders
    .filter((o) => o.status === "CLOSED" && Number.isFinite(o.realized_profit_usdt))
    .map((o) => ({ t: Date.parse(o.closed_at ?? o.created_at), pnl: o.realized_profit_usdt }))
    .sort((a, b) => a.t - b.t);
}

/**
 * Where the account stands against every limit right now.
 * @param orders every managed order of ONE account mode (paper or live)
 */
export function computeRiskState({ orders, settings, capital, now = Date.now() }) {
  const closed = closedTrades(orders);
  const todayPnl = closed.filter((c) => dayKey(c.t) === dayKey(now)).reduce((sum, c) => sum + c.pnl, 0);
  const openRisk = orders.filter((o) => OPEN.has(o.status)).reduce((sum, o) => sum + (Number(o.estimated_loss_usdt) || 0), 0);
  const openCount = orders.filter((o) => OPEN.has(o.status)).length;

  let lossStreak = 0;
  for (let i = closed.length - 1; i >= 0 && closed[i].pnl < 0; i--) lossStreak++;
  const lastClosedAt = closed.length ? closed[closed.length - 1].t : null;
  const cooldownUntil = lossStreak >= settings.maxLossStreak && lastClosedAt != null ? lastClosedAt + settings.cooldownMinutes * 60_000 : null;
  const cooldownActive = cooldownUntil != null && now < cooldownUntil;

  const resetAt = settings.drawdownResetAt ? Date.parse(settings.drawdownResetAt) : -Infinity;
  let cumulative = 0;
  let peak = 0;
  for (const c of closed.filter((x) => x.t >= resetAt)) {
    cumulative += c.pnl;
    peak = Math.max(peak, cumulative);
  }
  const drawdownUsd = peak - cumulative;

  const known = capital != null && capital > 0;
  const pct = (usd) => (known ? (usd / capital) * 100 : null);
  const dailyLossLimit = known ? (capital * settings.maxDailyLossPct) / 100 : null;
  const drawdownPct = pct(drawdownUsd);

  const blockers = [];
  if (settings.paused) blockers.push({ code: "paused", message: "Trading is paused (kill switch is on)." });
  if (settings.enabled && known) {
    if (todayPnl <= -dailyLossLimit) {
      blockers.push({ code: "daily_loss", message: `Daily loss limit reached: ${round2(todayPnl)} USDT today (limit −${round2(dailyLossLimit)}). New orders resume after 00:00 UTC.` });
    }
    if (cooldownActive) {
      const minutes = Math.ceil((cooldownUntil - now) / 60_000);
      blockers.push({ code: "loss_streak", message: `${lossStreak} losing trades in a row: cooling down for another ${minutes} min.` });
    }
    if (drawdownPct >= settings.maxDrawdownPct) {
      blockers.push({ code: "drawdown", message: `Drawdown ${drawdownPct.toFixed(1)}% reached the ${settings.maxDrawdownPct}% limit. Review your trades, then reset the drawdown baseline to continue.` });
    }
  }

  const usage = {
    dailyLoss: known ? Math.max(0, -todayPnl) / dailyLossLimit : null,
    openRisk: known ? openRisk / ((capital * settings.maxOpenRiskPct) / 100) : null,
    drawdown: known ? drawdownPct / settings.maxDrawdownPct : null,
    lossStreak: lossStreak / settings.maxLossStreak,
  };
  const worst = Math.max(...Object.values(usage).filter((v) => v != null), 0);
  const status = !settings.enabled && !settings.paused ? "off" : blockers.length ? "halted" : worst >= 0.7 ? "warning" : "ok";

  return {
    capital,
    capitalKnown: known,
    todayPnl: round2(todayPnl),
    dailyLossLimit: dailyLossLimit == null ? null : round2(dailyLossLimit),
    openRisk: round2(openRisk),
    openRiskPct: pct(openRisk),
    openCount,
    lossStreak,
    cooldownUntil: cooldownActive ? cooldownUntil : null,
    drawdownUsd: round2(drawdownUsd),
    drawdownPct,
    usage,
    blockers,
    status,
  };
}

/**
 * Money lost at the stop and gained at the target for `quantity`, fees on both sides.
 * A long buys at the entry and sells at the stop/target; a short (futures only) is the mirror image.
 */
export function estimateTrade({ entry, stop, target, quantity, feePercent, side = "long" }) {
  const f = feePercent / 100;
  if (side === "short") {
    const proceeds = entry * quantity * (1 - f);
    return {
      positionValue: entry * quantity,
      riskUsd: Math.max(0, stop * quantity * (1 + f) - proceeds),
      rewardUsd: proceeds - target * quantity * (1 + f),
    };
  }
  const cost = entry * quantity * (1 + f);
  return {
    positionValue: entry * quantity,
    riskUsd: Math.max(0, cost - stop * quantity * (1 - f)),
    rewardUsd: target * quantity * (1 - f) - cost,
  };
}

/**
 * Judge one proposed order. `allowed` is false when any limit is broken; `violations` say why in plain
 * words, and `suggestedPositionValue` is the largest position that would pass every size limit.
 */
export function checkOrder({ settings, state, order }) {
  const { entry, stop, target, quantity, feePercent, side = "long", leverage = 1 } = order;
  const short = side === "short";
  const trade = estimateTrade({ entry, stop, target, quantity, feePercent, side });
  const capital = state.capital;
  const known = capital != null && capital > 0;
  const f = feePercent / 100;
  const stopPct = (Math.abs(entry - stop) / entry) * 100;

  const riskPct = known ? (trade.riskUsd / capital) * 100 : null;
  // The size limit is measured on the money actually committed: with leverage that is the margin, not the notional.
  const marginUsd = trade.positionValue / leverage;
  const positionPct = known ? (marginUsd / capital) * 100 : null;
  const rewardRisk = trade.riskUsd > 0 ? trade.rewardUsd / trade.riskUsd : null;
  const openAfterPct = known ? ((state.openRisk + trade.riskUsd) / capital) * 100 : null;

  const violations = [...state.blockers.map((b) => ({ code: b.code, message: b.message }))];
  const warnings = [];

  // Largest position value that satisfies every size limit (risk per $ of position value = r).
  const r = short ? (stop / entry) * (1 + f) - (1 - f) : 1 + f - (stop / entry) * (1 - f);
  let suggestedPositionValue = null;
  if (known && r > 0) {
    const limits = [(capital * settings.riskPerTradePct) / 100 / r, ((capital * settings.maxPositionPct) / 100) * leverage];
    limits.push(Math.max(0, (capital * settings.maxOpenRiskPct) / 100 - state.openRisk) / r);
    suggestedPositionValue = Math.floor(Math.min(...limits) * 100) / 100;
  }

  // Leverage brings a liquidation price. Whatever the other settings, the stop must trigger well before it
  // (isolated margin: liquidation is about 100/leverage % away, less the maintenance margin).
  let liquidationPct = null;
  let maxSafeLeverage = null;
  if (leverage > 1) {
    liquidationPct = 100 / leverage - MAINTENANCE_MARGIN_PCT;
    maxSafeLeverage = Math.max(1, Math.floor(100 / (stopPct / LIQUIDATION_BUFFER + MAINTENANCE_MARGIN_PCT)));
    if (stopPct > LIQUIDATION_BUFFER * liquidationPct) {
      violations.push({ code: "liquidation", message: `At ${leverage}× the position is liquidated about ${Math.max(0, liquidationPct).toFixed(1)}% from the entry, too close to a ${stopPct.toFixed(2)}% stop. Use ${maxSafeLeverage}× or less, or a tighter stop.` });
    }
  }

  if (settings.enabled && known) {
    const eps = 1e-9;
    if (leverage > settings.maxLeverage) {
      violations.push({ code: "leverage", message: `Leverage ${leverage}× is above your ${settings.maxLeverage}× limit.` });
    }
    if (riskPct > settings.riskPerTradePct + eps) {
      violations.push({ code: "risk_per_trade", message: `Risk per trade is ${riskPct.toFixed(2)}% of capital, above the ${settings.riskPerTradePct}% limit (${round2(trade.riskUsd)} USDT lost if the stop fills).` });
    }
    if (positionPct > settings.maxPositionPct + eps) {
      violations.push({ code: "position_size", message: `${leverage > 1 ? "Margin used" : "Position"} is ${positionPct.toFixed(1)}% of capital, above the ${settings.maxPositionPct}% limit.` });
    }
    if (openAfterPct > settings.maxOpenRiskPct + eps) {
      violations.push({ code: "open_risk", message: `Total open risk would be ${openAfterPct.toFixed(2)}% of capital, above the ${settings.maxOpenRiskPct}% limit.` });
    }
    if (settings.minRewardRisk > 0 && (rewardRisk == null || rewardRisk < settings.minRewardRisk - eps)) {
      violations.push({ code: "reward_risk", message: `Reward-to-risk is ${rewardRisk == null ? "n/a" : rewardRisk.toFixed(2)}, below the ${settings.minRewardRisk} minimum: the target is too close to the stop.` });
    }
    if (!violations.length && riskPct >= 0.8 * settings.riskPerTradePct) warnings.push(`Uses ${Math.round((riskPct / settings.riskPerTradePct) * 100)}% of your per-trade risk budget.`);
  }
  if (stopPct < 0.15) warnings.push("The stop is very close to the entry: normal price noise may trigger it.");

  return {
    allowed: violations.length === 0,
    violations,
    warnings,
    riskUsd: round2(trade.riskUsd),
    riskPct,
    positionValue: round2(trade.positionValue),
    positionPct,
    rewardUsd: round2(trade.rewardUsd),
    rewardRisk,
    openRiskAfterPct: openAfterPct,
    suggestedPositionValue,
    marginUsd: round2(marginUsd),
    liquidationPct,
    maxSafeLeverage,
  };
}

/** Position value that risks exactly `riskPct` of capital with the stop `stopPct` below the entry. */
export function sizeByRisk({ capital, riskPct, stopPct, feePercent = 0.1 }) {
  const f = feePercent / 100;
  const r = 1 + f - (1 - stopPct / 100) * (1 - f);
  return r > 0 ? (capital * riskPct) / 100 / r : 0;
}

/** Fraction of capital lost after `n` losing trades in a row at a fixed risk %. */
export const lossAfterStreak = (riskPct, n) => 1 - (1 - riskPct / 100) ** n;

/** Performance summary of closed trades, for the Risk tab. */
export function tradeStats(orders) {
  const closed = closedTrades(orders);
  const wins = closed.filter((c) => c.pnl > 0);
  const losses = closed.filter((c) => c.pnl <= 0);
  const grossWin = wins.reduce((s, c) => s + c.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, c) => s + c.pnl, 0));
  let cumulative = 0;
  let peak = 0;
  let maxDrawdownUsd = 0;
  let streak = 0;
  let maxStreak = 0;
  for (const c of closed) {
    cumulative += c.pnl;
    peak = Math.max(peak, cumulative);
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - cumulative);
    streak = c.pnl < 0 ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
  }
  return {
    trades: closed.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : null,
    avgWin: wins.length ? grossWin / wins.length : null,
    avgLoss: losses.length ? -grossLoss / losses.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    expectancy: closed.length ? cumulative / closed.length : null,
    totalPnl: cumulative,
    best: closed.length ? Math.max(...closed.map((c) => c.pnl)) : null,
    worst: closed.length ? Math.min(...closed.map((c) => c.pnl)) : null,
    maxDrawdownUsd,
    maxLossStreak: maxStreak,
  };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * A complete, rule-abiding trade setup for the order ticket.
 *  - stop-loss: 1.5x the pair's recent volatility (ATR), kept between 0.4% and 6% below the entry
 *  - take-profit: far enough that the reward is at least 2x the risk AFTER fees (or your minimum, if higher)
 *  - size: the largest position that respects every size limit, the balance you can actually spend,
 *    and reports which of those was the binding one
 * `issues` lists reasons the setup cannot be traded (no room, below the exchange minimum, unknown capital).
 */
/** Stop-loss distance bounds (% below entry) per asset class: a currency moves ~0.6% a day, a crypto several %. */
export const STOP_BOUNDS = { crypto: [0.4, 6], stock: [0.3, 4], commodity: [0.3, 4], forex: [0.1, 1.5], other: [0.4, 6] };

export function riskSetup({ settings, state, price, atrPct = null, availableQuote, feePercent, minNotional = 0, category = "crypto", side = "long", leverage = 1, futures = false }) {
  const f = feePercent / 100;
  const short = side === "short";
  const atrBased = atrPct != null && Number.isFinite(atrPct) && atrPct > 0;
  const [minStop, maxStop] = STOP_BOUNDS[category] ?? STOP_BOUNDS.crypto;
  const stopPct = Math.round(clamp(atrBased ? 1.5 * atrPct : Math.max(1, minStop), minStop, maxStop) * 100) / 100;
  const stopPrice = short ? price * (1 + stopPct / 100) : price * (1 - stopPct / 100);

  const netRR = Math.max(2, settings.minRewardRisk);
  let targetPct;
  let targetPrice;
  if (short) {
    const netRiskPerUnit = stopPrice * (1 + f) - price * (1 - f);
    const target = (price * (1 - f) - netRR * netRiskPerUnit) / (1 + f);
    targetPct = Math.ceil((1 - target / price) * 10000) / 100;
    targetPrice = price * (1 - targetPct / 100);
  } else {
    const netRiskPerUnit = price * (1 + f) - stopPrice * (1 - f);
    targetPct = Math.ceil(((price * (1 + f) + netRR * netRiskPerUnit) / (1 - f) / price - 1) * 10000) / 100;
    targetPrice = price * (1 + targetPct / 100);
  }

  const issues = [];
  const capital = state.capital;
  const known = capital != null && capital > 0;
  const r = short ? (stopPrice / price) * (1 + f) - (1 - f) : 1 + f - (stopPrice / price) * (1 - f); // risk per $ of position value
  // Futures: the size limit and the balance both apply to the margin, and leverage multiplies what that margin controls.
  const lev = futures ? leverage : 1;
  const candidates = known
    ? [
        ["risk per trade", (capital * settings.riskPerTradePct) / 100 / r],
        ["max position size", ((capital * settings.maxPositionPct) / 100) * lev],
        ["open risk budget", Math.max(0, (capital * settings.maxOpenRiskPct) / 100 - state.openRisk) / r],
        ["available balance", futures ? Math.max(0, availableQuote) * lev : Math.max(0, availableQuote) * (1 - f)],
      ]
    : [];
  const [limitedBy, best] = candidates.length ? candidates.reduce((min, c) => (c[1] < min[1] ? c : min)) : [null, 0];
  const positionValue = Math.floor(Math.max(0, best) * 100) / 100;

  if (!known) issues.push("Account capital is not known yet.");
  else if (positionValue <= 0) issues.push(limitedBy === "available balance" ? "There is no free balance to trade with." : `Your ${limitedBy} limit leaves no room for a new position.`);
  else if (minNotional > 0 && positionValue < minNotional) {
    issues.push(`The size your rules allow (${positionValue.toFixed(2)} USDT, limited by ${limitedBy}) is below Binance's minimum order of ${minNotional} USDT for this pair. Add funds, or loosen the limit that binds.`);
  }

  const capitalUsd = futures ? positionValue / lev : positionValue / (1 - f);
  // 4 decimals of a percent: a small position on a big balance must not be rounded away
  const percentOfAvailable = availableQuote > 0 ? Math.min(100, Math.floor((capitalUsd / availableQuote) * 1e6) / 1e4) : 0;
  const trade = estimateTrade({ entry: price, stop: stopPrice, target: targetPrice, quantity: positionValue / price, feePercent, side });

  return {
    side,
    leverage: lev,
    stopPrice,
    targetPrice,
    entry: price,
    stopPct,
    targetPct,
    netRR,
    atrBased,
    positionValue,
    capitalUsd,
    percentOfAvailable,
    limitedBy,
    riskUsd: round2(trade.riskUsd),
    riskPct: known ? (trade.riskUsd / capital) * 100 : null,
    rewardUsd: round2(trade.rewardUsd),
    issues,
    tradable: issues.length === 0,
  };
}
