/**
 * Company analysis: a plain-language read of a business from its reported numbers, next to the chart analysis in
 * stock.js. Pure functions shared by the browser and the tests.
 *
 * For a company it scores out of 100 (each point explained):
 *   growth (25)        revenue and earnings growth, and whether revenue has risen year after year
 *   profitability (25) net and operating margin, return on equity
 *   financial health (20)  debt against equity, liquidity, free cash flow, cash against debt
 *   valuation (16)     price against earnings and against growth (P/E, PEG)
 *   analysts (10)      upside to the average price target and the consensus rating
 * Anything the data does not provide is left out and the score is scaled. Banks and insurers are not scored on debt
 * or liquidity, because their balance sheets work differently.
 *
 * For an ETF or fund it does not score, it lists what matters instead: cost, size, concentration, leverage.
 *
 * It only knows the reported numbers. It cannot judge the products, competition, management or the news.
 */

const factor = (group, label, points, max, note, tone) => ({ group, label, points, max, note, tone: tone ?? (points >= max * 0.66 ? "good" : points >= max * 0.33 ? "mixed" : "bad") });
const pct = (v, d = 1) => (v == null ? null : Math.round(v * 100 * 10 ** d) / 10 ** d);
const round = (n, d = 1) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
export const bigMoney = (n) => {
  if (n == null) return "—";
  const a = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(0)}M`;
  return `${sign}$${Math.round(a).toLocaleString()}`;
};

const LEVERAGED = /\b(2x|3x|-1x|-2x|-3x|bull|bear|ultra|inverse|short)\b/i;

/** Days from `now` to a date (ms since epoch), or null. */
const daysUntil = (ms, now) => (ms == null ? null : Math.ceil((ms - now) / 86_400_000));

export function analyzeCompany(company, { price = null, now = Date.now() } = {}) {
  if (!company) return { ok: false, reason: "No company data." };
  if (company.kind === "fund") return analyzeFund(company, { now });

  const v = company.valuation ?? {};
  const g = company.growth ?? {};
  const p = company.profitability ?? {};
  const h = company.health ?? {};
  const a = company.analysts ?? {};
  const financial = /financial/i.test(company.profile?.sector ?? "");
  const f = [];
  const flags = [];

  // ---- growth (25) ----
  if (g.revenueGrowth != null) {
    const x = g.revenueGrowth;
    f.push(factor("Growth", "Revenue growth", x > 0.15 ? 12 : x > 0.05 ? 8 : x > 0 ? 4 : 0, 12, `Revenue is ${x >= 0 ? "up" : "down"} ${Math.abs(pct(x))}% on a year ago${x > 0.15 ? ": fast growth." : x > 0.05 ? "." : x > 0 ? ": slow growth." : ": shrinking."}`));
  }
  if (g.earningsGrowth != null) {
    const x = g.earningsGrowth;
    f.push(factor("Growth", "Earnings growth", x > 0.15 ? 8 : x > 0 ? 5 : 0, 8, `Earnings are ${x >= 0 ? "up" : "down"} ${Math.abs(pct(x))}% on a year ago.`));
  }
  const years = (company.history ?? []).filter((y) => y.revenue != null).sort((x, y) => x.year - y.year);
  if (years.length >= 3) {
    const rising = years.every((y, i) => i === 0 || y.revenue > years[i - 1].revenue);
    const total = years[years.length - 1].revenue / years[0].revenue - 1;
    f.push(factor("Growth", "Revenue over the years", rising ? 5 : total > 0 ? 3 : 0, 5, rising ? `Revenue rose every year from ${years[0].year} to ${years[years.length - 1].year} (${total >= 0 ? "+" : ""}${round(total * 100, 0)}% in all).` : total > 0 ? `Revenue is higher than in ${years[0].year} but did not rise every year.` : `Revenue is lower than in ${years[0].year}.`));
  }

  // ---- profitability (25) ----
  if (p.profitMargins != null) {
    const x = p.profitMargins;
    f.push(factor("Profitability", "Net profit margin", x > 0.2 ? 10 : x > 0.1 ? 8 : x > 0.05 ? 5 : x > 0 ? 2 : 0, 10, x > 0 ? `Keeps ${pct(x)}% of revenue as profit${x > 0.2 ? ": very profitable." : x > 0.1 ? ": solidly profitable." : "."}` : `Loses ${Math.abs(pct(x))}% of revenue: not profitable.`));
  }
  if (p.operatingMargins != null) {
    const x = p.operatingMargins;
    f.push(factor("Profitability", "Operating margin", x > 0.2 ? 8 : x > 0.1 ? 6 : x > 0.05 ? 3 : x > 0 ? 1 : 0, 8, `Operating margin ${pct(x)}%${x > 0.2 ? ": the core business earns well." : x <= 0 ? ": the core business loses money." : "."}`));
  }
  if (p.returnOnEquity != null) {
    const x = p.returnOnEquity;
    f.push(factor("Profitability", "Return on equity", x > 0.15 ? 7 : x > 0.08 ? 4 : x > 0 ? 2 : 0, 7, `Return on equity ${pct(x, 0)}%${x > 0.15 ? ": uses shareholders' money well." : x <= 0 ? ": destroying value." : "."}`));
  }

  // ---- financial health (20) ----
  if (!financial && h.debtToEquity != null) {
    const x = h.debtToEquity; // Yahoo gives this as a percentage
    f.push(factor("Financial health", "Debt against equity", x < 50 ? 7 : x < 100 ? 5 : x < 200 ? 2 : 0, 7, `Debt is ${round(x, 0)}% of equity${x < 50 ? ": low debt." : x < 100 ? ": moderate." : x < 200 ? ": high." : ": very high."}`));
  }
  if (!financial && h.currentRatio != null) {
    const x = h.currentRatio;
    f.push(factor("Financial health", "Short-term liquidity", x > 1.5 ? 5 : x > 1 ? 3 : 0, 5, `Current ratio ${round(x, 2)}${x > 1.5 ? ": comfortably covers its short-term bills." : x > 1 ? ": covers its short-term bills." : ": short-term bills exceed short-term assets."}`));
  }
  if (h.freeCashflow != null) {
    const x = h.freeCashflow;
    f.push(factor("Financial health", "Free cash flow", x > 0 ? 5 : 0, 5, x > 0 ? `Generates ${bigMoney(x)} of free cash a year.` : `Burns ${bigMoney(-x)} of cash a year after investing: it depends on outside funding to keep going.`));
  }
  if (!financial && h.totalDebt != null && h.totalCash != null) {
    const ratio = h.totalDebt > 0 ? h.totalCash / h.totalDebt : Infinity;
    f.push(factor("Financial health", "Cash against debt", ratio >= 1 ? 3 : ratio >= 0.5 ? 1 : 0, 3, ratio >= 1 ? `Holds more cash (${bigMoney(h.totalCash)}) than debt (${bigMoney(h.totalDebt)}).` : `Cash ${bigMoney(h.totalCash)} against debt ${bigMoney(h.totalDebt)}.`));
  }

  // ---- valuation (16) ----
  const earnings = p.profitMargins != null ? p.profitMargins > 0 : v.trailingPE != null;
  const pe = v.forwardPE > 0 ? v.forwardPE : v.trailingPE > 0 ? v.trailingPE : null;
  if (pe != null) {
    f.push(factor("Valuation", "Price against earnings (P/E)", pe < 15 ? 10 : pe < 25 ? 8 : pe < 35 ? 5 : pe < 50 ? 2 : 0, 10, `P/E ${round(pe, 1)}${v.forwardPE > 0 ? " (expected earnings)" : ""}: ${pe < 15 ? "cheap by earnings." : pe < 25 ? "a fair price by earnings." : pe < 35 ? "a premium price." : pe < 50 ? "expensive." : "very expensive."}`));
  } else if (!earnings) {
    f.push(factor("Valuation", "Price against earnings (P/E)", 0, 10, "No profits to value it on: the price rests on hopes of future profit.", "bad"));
  }
  if (v.pegRatio != null && v.pegRatio > 0) {
    f.push(factor("Valuation", "Price against growth (PEG)", v.pegRatio < 1.5 ? 6 : v.pegRatio < 2.5 ? 4 : 1, 6, `PEG ${round(v.pegRatio, 1)}${v.pegRatio < 1.5 ? ": the price is reasonable for its growth." : v.pegRatio < 2.5 ? ": paying a fair premium for growth." : ": expensive for its growth."}`));
  }

  // ---- analysts (10) ----
  const covered = (a.count ?? 0) >= 5;
  if (covered && a.targetMean != null && price > 0) {
    const up = a.targetMean / price - 1;
    f.push(factor("Analysts", "Average price target", up > 0.2 ? 5 : up > 0.1 ? 4 : up > 0 ? 2 : 0, 5, `Analysts' average target ${round(a.targetMean, 2)} is ${up >= 0 ? "" : "−"}${Math.abs(round(up * 100, 0))}% ${up >= 0 ? "above" : "below"} the price (${a.count} analysts).`));
  }
  if (covered && a.recommendation) {
    const key = String(a.recommendation);
    const points = /strong_buy|^buy$/.test(key) ? 5 : key === "hold" ? 2 : 0;
    f.push(factor("Analysts", "Consensus rating", points, 5, `Analysts' consensus: ${key.replace("_", " ")}.`));
  }

  const max = f.reduce((s, x) => s + x.max, 0);
  const total = f.reduce((s, x) => s + x.points, 0);
  const enough = f.length >= 5 && max >= 40;
  const score = enough ? Math.round((total / max) * 100) : null;

  // ---- flags ----
  if (p.profitMargins != null && p.profitMargins <= 0) flags.push("Not profitable: the business loses money, so the price depends on future promises.");
  if (h.freeCashflow != null && h.freeCashflow < 0) flags.push("Burning cash after investment: watch for share sales (dilution) or new debt.");
  if (!financial && h.debtToEquity != null && h.debtToEquity > 200) flags.push("Very high debt compared with equity.");
  if (pe != null && pe > 40 && (g.revenueGrowth == null || g.revenueGrowth < 0.15)) flags.push("Expensive price for modest growth: the market expects a lot.");
  if (v.shortPercentOfFloat != null && v.shortPercentOfFloat > 0.1) flags.push(`${pct(v.shortPercentOfFloat, 0)}% of the tradable shares are sold short: many investors are betting against it.`);
  if (a.targetMean != null && price > 0 && covered && a.targetMean < price * 0.9) flags.push("The average analyst target is below the current price.");
  if (v.marketCap != null && v.marketCap < 1e9) flags.push("Small company (under $1B): usually more volatile and less predictable.");
  if (!covered) flags.push("Few or no analysts cover it: less information is available.");
  const earningsIn = daysUntil(company.events?.nextEarnings, now);
  if (earningsIn != null && earningsIn >= 0 && earningsIn <= 21) flags.push(`Earnings report ${earningsIn === 0 ? "today" : `in ${earningsIn} day${earningsIn === 1 ? "" : "s"}`}: results often move the price sharply, either way.`);
  if (financial) flags.push("Financial company: debt and liquidity are not scored, because banks and insurers use borrowed money by design.");

  let verdict;
  if (score == null) verdict = { label: "Not enough data to score", tone: "mixed", summary: "Too few reported figures were available to judge this company fairly." };
  else if (score >= 70) verdict = { label: "Strong fundamentals", tone: "good", summary: "Growing, profitable and financially sound on the numbers, with a valuation that is not extreme." };
  else if (score >= 55) verdict = { label: "Decent business", tone: "good", summary: "More strengths than weaknesses on the numbers. Check the flags below." };
  else if (score >= 40) verdict = { label: "Mixed fundamentals", tone: "mixed", summary: "Some numbers are good and some are not. There is no clear fundamental case either way." };
  else verdict = { label: "Weak fundamentals", tone: "bad", summary: "Most reported numbers are weak. Owning it is a bet on a turnaround or on future profit." };

  return { ok: true, kind: "company", score, verdict, factors: f, flags, earningsInDays: earningsIn };
}

export function analyzeFund(fund, { now = Date.now() } = {}) {
  const facts = fund.fund ?? {};
  const flags = [];
  const f = [];
  const name = `${fund.profile?.name ?? ""}`;
  if (facts.expenseRatio != null) {
    const x = facts.expenseRatio;
    f.push(factor("Fund", "Yearly cost", x <= 0.004 ? 5 : x <= 0.0075 ? 3 : 0, 5, `Costs ${round(x * 100, 2)}% a year${x <= 0.004 ? ": cheap." : x <= 0.0075 ? "." : ": expensive for a fund."}`));
    if (x > 0.0075) flags.push(`High cost (${round(x * 100, 2)}% a year) eats into returns.`);
  }
  if (facts.totalAssets != null) {
    const x = facts.totalAssets;
    f.push(factor("Fund", "Size", x >= 1e9 ? 5 : x >= 1e8 ? 3 : 0, 5, `Manages ${bigMoney(x)}${x >= 1e9 ? ": large and liquid." : x >= 1e8 ? "." : ": small."}`));
    if (x < 5e7) flags.push("Small fund (under $50M): wider prices to trade and a real chance it is closed down.");
  }
  const top = (facts.topHoldings ?? []).slice(0, 10);
  const topWeight = top.reduce((s, x) => s + (x.weight ?? 0), 0);
  if (top.length >= 5) {
    f.push(factor("Fund", "Concentration", topWeight < 0.4 ? 5 : topWeight < 0.6 ? 3 : 1, 5, `The top ${top.length} holdings make up ${round(topWeight * 100, 0)}% of the fund${topWeight >= 0.6 ? ": concentrated, so few names drive the result." : "."}`));
  }
  if (LEVERAGED.test(name) || LEVERAGED.test(facts.category ?? "")) flags.push("Leveraged or inverse fund: it resets every day, so holding it for weeks can lose money even when the market ends flat. Meant for short-term trading.");
  if (/commodit/i.test(facts.category ?? "")) flags.push("A commodity fund holds no companies: its price follows the commodity, with no earnings behind it.");
  const days = daysUntil(fund.events?.exDividendDate, now);
  if (days != null && days >= 0 && days <= 7) flags.push(`It goes ex-dividend in ${days} day${days === 1 ? "" : "s"}: the price drops by the payout that day.`);
  return {
    ok: true,
    kind: "fund",
    score: null,
    verdict: { label: "Fund: nothing to score", tone: "mixed", summary: "A fund is judged on what it holds, what it costs and how big it is, not on company profits. The facts are below." },
    factors: f,
    flags,
  };
}

/** One sentence putting the chart read and the company read side by side. */
export function combinedRead(technical, company) {
  if (!technical?.ok) return null;
  const chart = technical.verdict.tone; // good | caution | mixed | bad
  const chartGood = chart === "good" || chart === "caution";
  if (!company?.ok || company.kind === "fund" || company.score == null) {
    return chartGood
      ? "The chart supports buying; there is no company score to compare it with."
      : "The chart does not support buying right now.";
  }
  const strong = company.score >= 60;
  const weak = company.score < 40;
  if (chartGood && strong) return "The chart and the business agree: strong numbers and a supportive trend. That is the best combination, though price still matters.";
  if (chartGood && weak) return "The chart is strong but the business is weak on the numbers: this is a momentum bet. Keep it small and respect the stop.";
  if (chartGood) return "The chart is supportive and the business is average: a reasonable trade, not a compelling one.";
  if (chart === "bad" && strong) return "A sound business in a weak chart. The numbers are good, but the market is selling: patience is reasonable while the trend is down.";
  if (chart === "bad" && weak) return "Both the chart and the business are weak. There is no good reason to buy now.";
  if (strong) return "A strong business with an undecided chart: the numbers are good but the trend has not confirmed a move yet. Waiting for the chart to improve, or building a position slowly, are both reasonable.";
  if (weak) return "Weak numbers and no clear chart signal: nothing here makes a strong case to buy.";
  return "The signals are mixed: neither the chart nor the business gives a clear reason to buy now.";
}
