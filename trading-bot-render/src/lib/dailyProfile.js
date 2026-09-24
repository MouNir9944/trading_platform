/**
 * Chart primitive that paints each day's volume profile behind the candles:
 *  - a histogram anchored to the start of the day, longer bars where more volume traded
 *    (value area brighter, the POC row in amber)
 *  - that day's POC / VAH / VAL as thin lines across the day
 *  - the previous day's POC / VAH / VAL projected across the next day, the levels traders watch for a reaction
 *
 * Everything is placed from candle times and prices, so it stays glued to the candles while you scroll and zoom.
 * `days` comes from dailyProfiles() in shared/analysis/volumeProfile.js.
 */

const COLORS = {
  poc: "#e0aa48",
  value: "#5b9cff",
  prev: "#a78bfa",
};

const MAX_BAR_SHARE = 0.42; // the longest bar covers at most this share of the day's width
const MAX_BAR_PX = 240;
const MIN_DAY_PX = 36; // narrower than this, the histogram is unreadable, so only the lines are drawn

const rgba = (hex, alpha) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

class ProfileRenderer {
  constructor(source) {
    this.source = source;
  }

  draw(target) {
    const { chart, series, days, showProfile, showPrev } = this.source;
    if (!chart || !series || !days.length || (!showProfile && !showPrev)) return;
    const scale = chart.timeScale();

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const { width } = mediaSize;
      const half = scale.options().barSpacing / 2;
      const yOf = (price) => series.priceToCoordinate(price);

      const line = (price, x1, x2, color, { dash = [], lineWidth = 1 } = {}) => {
        const y = yOf(price);
        if (y == null || x2 <= x1) return null;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.setLineDash(dash);
        ctx.beginPath();
        ctx.moveTo(x1, y + 0.5);
        ctx.lineTo(x2, y + 0.5);
        ctx.stroke();
        ctx.restore();
        return y;
      };

      const tag = (text, x, y, color) => {
        ctx.font = "600 10px Inter, sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = color;
        ctx.fillText(text, x, y - 2);
      };

      days.forEach((day, i) => {
        const first = scale.timeToCoordinate(day.startTime);
        const next = days[i + 1];
        const endX = next ? scale.timeToCoordinate(next.startTime) : width;
        if (first == null || endX == null) return;
        const dayLeft = first - half;
        const dayRight = next ? endX - half : width;
        if (dayRight <= 0 || dayLeft >= width) return;
        const left = Math.max(0, dayLeft);
        const right = Math.min(width, dayRight);
        const last = i === days.length - 1;

        if (showProfile) {
          const maxVolume = Math.max(...day.rows.map((r) => r.volume));
          const maxWidth = Math.min(MAX_BAR_PX, (dayRight - dayLeft) * MAX_BAR_SHARE);
          if (maxVolume > 0 && right - left >= MIN_DAY_PX) {
            day.rows.forEach((row, index) => {
              const top = yOf(row.high);
              const bottom = yOf(row.low);
              if (top == null || bottom == null || row.volume <= 0) return;
              const inValue = day.vaLow == null || (index >= day.vaLow && index <= day.vaHigh);
              ctx.fillStyle = index === day.pocIndex ? rgba(COLORS.poc, 0.55) : rgba(COLORS.value, inValue ? 0.34 : 0.16);
              ctx.fillRect(left, Math.min(top, bottom), Math.max(1, (row.volume / maxVolume) * maxWidth), Math.max(1, Math.abs(bottom - top) - 0.5));
            });
          }
          line(day.vah, left, right, rgba(COLORS.value, 0.5), { dash: [2, 4] });
          line(day.val, left, right, rgba(COLORS.value, 0.5), { dash: [2, 4] });
          const y = line(day.poc, left, right, rgba(COLORS.poc, 0.85), { lineWidth: 1.4 });
          if (last && y != null) tag(`POC ${formatLevel(day.poc)}`, right - 6, y, COLORS.poc);
        }

        // Yesterday's finished levels, carried across today.
        const prev = days[i - 1];
        if (showPrev && prev && !prev.developing) {
          const style = { dash: [7, 4], lineWidth: 1.2 };
          const items = [["pPOC", prev.poc, COLORS.poc], ["pVAH", prev.vah, COLORS.prev], ["pVAL", prev.val, COLORS.prev]];
          for (const [name, price, color] of items) {
            const y = line(price, left, right, rgba(color, 0.9), style);
            if (last && y != null) tag(`${name} ${formatLevel(price)}`, right - 6, y, color);
          }
        }
      });
    });
  }
}

/** Prices span many magnitudes (0.19 to 65,000): keep about five significant digits. */
function formatLevel(price) {
  if (!Number.isFinite(price)) return "—";
  return Number(price.toPrecision(5)).toString();
}

class ProfilePaneView {
  constructor(source) {
    this.rendererInstance = new ProfileRenderer(source);
  }

  zOrder() {
    return "bottom";
  }

  renderer() {
    return this.rendererInstance;
  }
}

export class DailyProfilePrimitive {
  constructor(series) {
    this.series = series;
    this.chart = null;
    this.requestUpdate = null;
    this.days = [];
    this.showProfile = false;
    this.showPrev = false;
    this.views = [new ProfilePaneView(this)];
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

  set({ days = [], showProfile = false, showPrev = false }) {
    this.days = days;
    this.showProfile = showProfile;
    this.showPrev = showPrev;
    this.requestUpdate?.();
  }
}
