/**
 * Chart primitive that paints, behind the candles:
 *  - one tinted band per calendar day (each weekday has its own colour) with a "Sat 19" label
 *  - an optional thin strip showing the trading sessions (Asia / London / New York)
 *
 * Bands are positioned from candle times (`timeToCoordinate`), so they stay glued to the candles
 * while you scroll and zoom, with no DOM syncing.
 */

// Monday..Sunday. Weekend days are warm so they stand out at a glance.
export const WEEKDAY_COLORS = ["#5b9cff", "#2dd4bf", "#a78bfa", "#38bdf8", "#f472b6", "#e0aa48", "#fb7185"];

const DAY_TINT = 0.075;
const STRIP_HEIGHT = 4;
const PEAK_COLOR = "#f5c518";
const PEAK_TINT = 0.06;

function withAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

class BandsRenderer {
  constructor(source) {
    this.source = source;
  }

  draw(target) {
    const { chart, days, sessions, peak, times, showDays, showSessions, showPeak } = this.source;
    if (!chart || (!showDays && !showSessions && !showPeak)) return;
    const scale = chart.timeScale();

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const { width, height } = mediaSize;
      // Band edges sit half a bar either side of the first and last candle of the run.
      const half = scale.options().barSpacing / 2;
      const spanOf = (startIndex, endIndex, isLast) => {
        const first = scale.timeToCoordinate(times[startIndex]);
        const last = scale.timeToCoordinate(times[endIndex - 1]);
        if (first == null || last == null) return null;
        const left = first - half;
        // The last band runs on into the empty space at the right edge.
        const x1 = Math.max(0, left);
        const x2 = Math.min(width, isLast ? width : last + half);
        return x2 > x1 ? { x1, x2, rawLeft: left } : null;
      };

      if (showDays) {
        days.forEach((day, i) => {
          const span = spanOf(day.startIndex, day.endIndex, i === days.length - 1);
          if (!span) return;
          const color = WEEKDAY_COLORS[day.weekday] ?? WEEKDAY_COLORS[0];
          ctx.fillStyle = withAlpha(color, DAY_TINT);
          ctx.fillRect(span.x1, 0, span.x2 - span.x1, height);
          if (span.rawLeft >= 0) {
            ctx.fillStyle = withAlpha(color, 0.35);
            ctx.fillRect(span.rawLeft, 0, 1, height);
          }
          if (span.x2 - span.x1 > 52) {
            ctx.font = "600 11px Inter, sans-serif";
            ctx.textBaseline = "top";
            ctx.fillStyle = withAlpha(color, 0.95);
            ctx.fillText(day.label, span.x1 + 7, showSessions ? STRIP_HEIGHT + 4 : 5);
          }
        });
      }

      if (showSessions) {
        sessions.forEach((segment, i) => {
          const span = spanOf(segment.startIndex, segment.endIndex, i === sessions.length - 1);
          if (!span) return;
          ctx.fillStyle = withAlpha(segment.session.color, 0.85);
          ctx.fillRect(span.x1, 0, span.x2 - span.x1, STRIP_HEIGHT);
        });
      }

      if (showPeak) {
        peak.forEach((segment, i) => {
          const span = spanOf(segment.startIndex, segment.endIndex, i === peak.length - 1);
          if (!span) return;
          ctx.fillStyle = withAlpha(PEAK_COLOR, PEAK_TINT);
          ctx.fillRect(span.x1, 0, span.x2 - span.x1, height);
        });
      }
    });
  }
}

class BandsPaneView {
  constructor(source) {
    this.rendererInstance = new BandsRenderer(source);
  }

  zOrder() {
    return "bottom";
  }

  renderer() {
    return this.rendererInstance;
  }
}

export class TimeBandsPrimitive {
  constructor() {
    this.chart = null;
    this.requestUpdate = null;
    this.days = [];
    this.sessions = [];
    this.peak = [];
    this.times = [];
    this.showDays = true;
    this.showSessions = false;
    this.showPeak = false;
    this.views = [new BandsPaneView(this)];
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

  set({ days, sessions, peak, times, showDays, showSessions, showPeak }) {
    this.days = days;
    this.times = times;
    this.sessions = sessions;
    this.peak = peak;
    this.showDays = showDays;
    this.showSessions = showSessions;
    this.showPeak = showPeak;
    this.requestUpdate?.();
  }
}
