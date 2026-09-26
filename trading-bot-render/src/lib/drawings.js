/**
 * Chart primitive for trader-drawn trendlines, horizontal lines and rectangles. Positions are stored as
 * time/price pairs (not pixels), so drawings stay glued to the chart while you scroll and zoom - the same
 * approach as the other primitives (zones, time bands).
 *
 *  trendline:  { id, type: "trendline", t1, p1, t2, p2 }
 *  horizontal: { id, type: "horizontal", p }                 (spans the full width, time-independent)
 *  rectangle:  { id, type: "rectangle", t1, p1, t2, p2 }
 */

const STYLE = {
  trendline: { stroke: "#5b9cff" },
  horizontal: { stroke: "#e0aa48" },
  rectangle: { stroke: "#a78bfa", fill: "rgba(167, 139, 250, 0.14)" },
};

class DrawingsRenderer {
  constructor(source) {
    this.source = source;
  }

  draw(target) {
    const { chart, series, drawings, draft, currentPrice } = this.source;
    if (!chart || !series || (!drawings.length && !draft)) return;
    const scale = chart.timeScale();

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const { width } = mediaSize;
      const xOf = (time) => (time == null ? null : scale.timeToCoordinate(time));
      const yOf = (price) => series.priceToCoordinate(price);

      const pctLabel = (price) => {
        if (!Number.isFinite(currentPrice) || currentPrice <= 0) return "";
        const pct = ((price - currentPrice) / currentPrice) * 100;
        return ` (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`;
      };

      const drawTrendline = (shape, alpha = 1) => {
        const x1 = xOf(shape.t1);
        const y1 = yOf(shape.p1);
        const x2 = xOf(shape.t2);
        const y2 = yOf(shape.p2);
        if ([x1, y1, x2, y2].some((v) => v == null || !Number.isFinite(v))) return;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = STYLE.trendline.stroke;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.fillStyle = STYLE.trendline.stroke;
        for (const [x, y] of [[x1, y1], [x2, y2]]) {
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      };

      const drawHorizontal = (shape, alpha = 1) => {
        const y = yOf(shape.p);
        if (y == null || !Number.isFinite(y)) return;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = STYLE.horizontal.stroke;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = "600 10px Inter, sans-serif";
        ctx.fillStyle = STYLE.horizontal.stroke;
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillText(`${shape.p.toFixed(5)}${pctLabel(shape.p)}`, 6, y - 3);
        ctx.restore();
      };

      const drawRectangle = (shape, alpha = 1) => {
        const x1 = xOf(shape.t1);
        const y1 = yOf(shape.p1);
        const x2 = xOf(shape.t2);
        const y2 = yOf(shape.p2);
        if ([x1, y1, x2, y2].some((v) => v == null || !Number.isFinite(v))) return;
        const left = Math.min(x1, x2);
        const right = Math.max(x1, x2);
        const top = Math.min(y1, y2);
        const bottom = Math.max(y1, y2);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = STYLE.rectangle.fill;
        ctx.fillRect(left, top, right - left, bottom - top);
        ctx.strokeStyle = STYLE.rectangle.stroke;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(left + 0.5, top + 0.5, Math.max(0, right - left - 1), Math.max(0, bottom - top - 1));
        const hi = Math.max(shape.p1, shape.p2);
        const lo = Math.min(shape.p1, shape.p2);
        if (right - left > 60) {
          ctx.font = "600 10px Inter, sans-serif";
          ctx.fillStyle = STYLE.rectangle.stroke;
          ctx.textAlign = "left";
          ctx.textBaseline = "top";
          ctx.fillText(`${hi.toFixed(5)} – ${lo.toFixed(5)}${pctLabel(hi)}`, left + 5, top + 4);
        }
        ctx.restore();
      };

      const paint = (shape, alpha) => {
        if (shape.type === "trendline") drawTrendline(shape, alpha);
        else if (shape.type === "horizontal") drawHorizontal(shape, alpha);
        else if (shape.type === "rectangle") drawRectangle(shape, alpha);
      };

      for (const shape of drawings) paint(shape, 1);
      if (draft) paint(draft, 0.6);
    });
  }
}

class DrawingsPaneView {
  constructor(source) {
    this.rendererInstance = new DrawingsRenderer(source);
  }

  zOrder() {
    return "top";
  }

  renderer() {
    return this.rendererInstance;
  }
}

export class DrawingsPrimitive {
  constructor(series) {
    this.series = series;
    this.chart = null;
    this.requestUpdate = null;
    this.drawings = [];
    this.draft = null;
    this.currentPrice = null;
    this.views = [new DrawingsPaneView(this)];
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

  set({ drawings = [], draft = null, currentPrice = null }) {
    this.drawings = drawings;
    this.draft = draft;
    this.currentPrice = currentPrice;
    this.requestUpdate?.();
  }
}

const TOOL_LABEL = { trendline: "Trendline", horizontal: "Horizontal line", rectangle: "Rectangle" };

/** Short label for a drawing, for the list menu ("Trendline", "Horizontal 0.02283"). */
export function drawingLabel(shape) {
  if (shape.type === "horizontal") return `${TOOL_LABEL.horizontal} ${shape.p.toFixed(5)}`;
  return TOOL_LABEL[shape.type] ?? shape.type;
}
