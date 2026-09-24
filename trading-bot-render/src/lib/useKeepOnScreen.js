import { useLayoutEffect } from "react";

/**
 * Keeps an absolutely-positioned dropdown on screen when its trigger button sits close enough to an edge that the
 * CSS default (left:0, or centered on narrow screens) would clip it — most visibly on a phone-width toolbar, where
 * a button can end up anywhere in a wrapped row. Desktop widths are left untouched, since there is normally enough
 * room there for the plain CSS positioning.
 *
 * Expects the CSS to already center the panel at narrow widths (`left: 50%; transform: translateX(-50%)`, e.g. in
 * the `max-width: 640px` rule for `.ind-menu`/`.strat-menu`); this only nudges that centered position sideways by
 * the smallest amount needed to clear the viewport's edges, so it still reads as "attached to the button" when
 * there is room, and only shifts when there truly isn't.
 */
export function useKeepOnScreen(ref, open, { gutter = 12, breakpoint = 640 } = {}) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return undefined;

    function place() {
      el.style.transform = "";
      if (!window.matchMedia(`(max-width: ${breakpoint}px)`).matches) return; // desktop: the plain CSS position already fits
      // clientWidth, not innerWidth: a panel wide enough to force a horizontal scrollbar inflates innerWidth to
      // include it, understating how far the panel actually reaches past the true visible edge.
      const viewportWidth = document.documentElement.clientWidth;
      const rect = el.getBoundingClientRect();
      const overflowRight = rect.right - (viewportWidth - gutter);
      const overflowLeft = gutter - rect.left;
      const shift = overflowRight > 0 ? -overflowRight : overflowLeft > 0 ? overflowLeft : 0;
      if (shift !== 0) el.style.transform = `translateX(calc(-50% + ${shift}px))`;
    }

    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, ref, gutter, breakpoint]);
}
