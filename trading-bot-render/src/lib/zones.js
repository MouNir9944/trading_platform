/**
 * Chart primitive that paints price zones behind the candles: fair value gaps, order blocks, the
 * premium/discount halves, liquidity levels, market-structure lines and text labels. Everything is positioned from
 * candle times and prices, so it stays glued to the chart while you scroll and zoom.
 *
 *  zones:  { top, bottom, time, endTime?, kind? | fill?, border?, label?, textColor? }
 *  lines:  { price, time, endTime?, kind? | color?, dash?, width?, label?, labelAt?: "start"|"mid"|"end",
 *            labelSide?: "above"|"below", fontSize?, swept? }
 *  labels: { time, price, text, color, side?: "above"|"below", size? }
 */

const STYLES = {
  "fvg-bull": { fill: "rgba(53, 196, 140, 0.16)", line: "rgba(53, 196, 140, 0.7)", text: "#7be0b5" },
  "fvg-bear": { fill: "rgba(238, 106, 88, 0.16)", line: "rgba(238, 106, 88, 0.7)", text: "#f59a8d" },
  "ob-bull": { fill: "rgba(91, 156, 255, 0.17)", line: "rgba(91, 156, 255, 0.75)", text: "#9cc2ff" },
  "ob-bear": { fill: "rgba(224, 170, 72, 0.17)", line: "rgba(224, 170, 72, 0.75)", text: "#f0c880" },
  "pd-premium": { fill: "rgba(238, 106, 88, 0.05)", line: null, text: "rgba(245, 154, 141, 0.8)" },
  "pd-discount": { fill: "rgba(53, 196, 140, 0.05)", line: null, text: "rgba(123, 224, 181, 0.8)" },
};

const LINE_STYLES = {
  high: "rgba(238, 106, 88, 0.85)",
  low: "rgba(53, 196, 140, 0.85)",
  eq: "rgba(168, 179, 199, 0.7)",
};

class ZonesRenderer {
  constructor(source) {
    this.source = source;
  }

  draw(target) {
    const { chart, series, zones, lines, labels } = this.source;
    if (!chart || !series || (!zones.length && !lines.length && !labels.length)) return;
    const scale = chart.timeScale();

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const { width } = mediaSize;
      const xOf = (time, fallback) => {
        if (time == null) return fallback;
        const x = scale.timeToCoordinate(time);
        return x == null ? null : x;
      };

      for (const zone of zones) {
        const style = zone.kind ? STYLES[zone.kind] : null;
        const fill = zone.fill ?? style?.fill;
        const border = zone.border !== undefined ? zone.border : style?.line;
        const yTop = series.priceToCoordinate(zone.top);
        const yBottom = series.priceToCoordinate(zone.bottom);
        const x1 = xOf(zone.time, 0);
        const x2 = xOf(zone.endTime, width);
        if (!fill || yTop == null || yBottom == null || x1 == null || x2 == null) continue;
        const left = Math.max(0, x1);
        const right = Math.min(width, x2);
        if (right <= left) continue;
        const top = Math.min(yTop, yBottom);
        const height = Math.max(1, Math.abs(yBottom - yTop));
        ctx.fillStyle = fill;
        ctx.fillRect(left, top, right - left, height);
        if (border) {
          ctx.strokeStyle = border;
          ctx.lineWidth = 1;
          ctx.strokeRect(left + 0.5, top + 0.5, right - left - 1, Math.max(0, height - 1));
        }
        if (zone.label && height >= 11 && right - left > 40) {
          ctx.font = "600 10px Inter, sans-serif";
          ctx.textBaseline = "middle";
          ctx.textAlign = "left";
          ctx.fillStyle = zone.textColor ?? style?.text ?? "#cbd5e1";
          ctx.fillText(zone.label, left + 5, top + Math.min(height / 2, 9));
        }
      }

      for (const line of lines) {
        const y = series.priceToCoordinate(line.price);
        const x1 = xOf(line.time, 0);
        const x2 = xOf(line.endTime, width);
        if (y == null || x1 == null || x2 == null) continue;
        const left = Math.max(0, x1);
        const right = Math.min(width, x2);
        if (right <= left) continue;
        const color = line.color ?? LINE_STYLES[line.kind] ?? LINE_STYLES.eq;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = line.width ?? (line.swept ? 1 : 1.5);
        ctx.setLineDash(line.dash ?? (line.swept ? [2, 4] : [6, 4]));
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
        ctx.restore();
        if (line.label) {
          const size = line.fontSize ?? 10;
          ctx.font = `600 ${size}px Inter, sans-serif`;
          ctx.fillStyle = color;
          ctx.textBaseline = line.labelSide === "below" ? "top" : "bottom";
          const at = line.labelAt ?? "end";
          if (at === "mid") {
            ctx.textAlign = "center";
            ctx.fillText(line.label, (Math.max(0, x1) + Math.min(width, x2)) / 2, line.labelSide === "below" ? y + 3 : y - 3);
          } else if (at === "start") {
            ctx.textAlign = "left";
            ctx.fillText(line.label, left + 4, line.labelSide === "below" ? y + 3 : y - 3);
          } else {
            ctx.textAlign = "left";
            ctx.fillText(line.label, Math.max(left + 4, right - 78), line.labelSide === "below" ? y + 3 : y - 3);
          }
        }
      }

      for (const label of labels) {
        const y = series.priceToCoordinate(label.price);
        const x = xOf(label.time, null);
        if (y == null || x == null || x < -20 || x > width + 20) continue;
        ctx.font = `600 ${label.size ?? 10}px Inter, sans-serif`;
        ctx.fillStyle = label.color;
        ctx.textAlign = "center";
        ctx.textBaseline = label.side === "below" ? "top" : "bottom";
        ctx.fillText(label.text, x, label.side === "below" ? y + 4 : y - 4);
      }
    });
  }
}

class ZonesPaneView {
  constructor(source) {
    this.rendererInstance = new ZonesRenderer(source);
  }

  zOrder() {
    return "bottom";
  }

  renderer() {
    return this.rendererInstance;
  }
}

export class ZonesPrimitive {
  constructor(series) {
    this.series = series;
    this.chart = null;
    this.requestUpdate = null;
    this.zones = [];
    this.lines = [];
    this.labels = [];
    this.views = [new ZonesPaneView(this)];
  }

  attached({ chart, requestUpdate }) {
    this.chart = chart;
    this.requestUpdate = requestUpdate;
  }

  detached() {
    this.chart = null;
    this.requestUpdate = null;
  }

  paneViews() {
    return this.views;
  }

  set({ zones = [], lines = [], labels = [] }) {
    this.zones = zones;
    this.lines = lines;
    this.labels = labels;
    this.requestUpdate?.();
  }
}

/** Turn the analysis' smart-money output into drawable zones, respecting which overlays are switched on. */
export function buildZoneOverlays(analysis, toggles) {
  const zones = [];
  const lines = [];
  const smc = analysis?.smc;
  if (!smc) return { zones, lines };
  const candles = analysis.ctx.candles;

  if (toggles.pd && smc.premiumDiscount) {
    const pd = smc.premiumDiscount;
    const time = Math.min(pd.highTime, pd.lowTime);
    zones.push({ kind: "pd-premium", top: pd.high, bottom: pd.equilibrium, time, label: "Premium" });
    zones.push({ kind: "pd-discount", top: pd.equilibrium, bottom: pd.low, time, label: "Discount" });
    lines.push({ kind: "eq", price: pd.equilibrium, time, label: "EQ 50%" });
  }
  if (toggles.fvg) {
    for (const g of smc.fvgs.filter((x) => x.filledAt == null).slice(-12)) {
      zones.push({ kind: g.type === "bull" ? "fvg-bull" : "fvg-bear", top: g.top, bottom: g.bottom, time: g.time, label: `FVG ${g.type === "bull" ? "▲" : "▼"}${g.touchedAt != null ? ` ${Math.round(g.fillPct * 100)}%` : ""}` });
    }
  }
  if (toggles.ob) {
    for (const b of smc.orderBlocks.filter((x) => x.mitigatedAt == null).slice(-8)) {
      zones.push({ kind: b.type === "bull" ? "ob-bull" : "ob-bear", top: b.top, bottom: b.bottom, time: b.time, label: `OB ${b.type === "bull" ? "▲" : "▼"}` });
    }
  }
  if (toggles.liq) {
    for (const pool of smc.liquidity.filter((x) => x.brokenAt == null).slice(-10)) {
      const high = pool.type === "high";
      lines.push({
        kind: pool.type,
        price: pool.price,
        time: pool.time,
        endTime: pool.sweptAt != null ? candles[pool.sweptAt].time : null,
        swept: pool.sweptAt != null,
        label: `${high ? "EQH" : "EQL"} ×${pool.touches}${pool.sweptAt != null ? " swept" : ""}`,
      });
    }
  }
  return { zones, lines };
}
