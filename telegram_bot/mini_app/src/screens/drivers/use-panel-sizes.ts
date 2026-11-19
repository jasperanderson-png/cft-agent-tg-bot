import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';

/**
 * The heights of the top panel and the bottom card, kept in `sizes` (the map's framing and the button
 * column follow them) and in the --sheet-h CSS variable. Give `topRef` to the top panel and `sheetCb`
 * to the bottom card.
 */
export function usePanelSizes(rootRef: RefObject<HTMLDivElement | null>) {
  const topRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLElement | null>(null);
  const sizes = useRef({ top: 150, bottom: 0, h: 800 });
  const measure = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const r = root.getBoundingClientRect();
    const top = topRef.current ? topRef.current.getBoundingClientRect().bottom - r.top : 0;
    const bottom = sheetRef.current ? r.bottom - sheetRef.current.getBoundingClientRect().top : 0;
    sizes.current = { top, bottom: Math.max(0, bottom), h: r.height };
    root.style.setProperty('--sheet-h', `${Math.max(0, bottom)}px`);
  }, [rootRef]);
  const ro = useMemo(() => (typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure())), [measure]);
  const sheetCb = useCallback((el: HTMLElement | null) => {
    if (sheetRef.current && ro) ro.unobserve(sheetRef.current);
    sheetRef.current = el;
    if (el && ro) ro.observe(el);
    measure();
  }, [ro, measure]);
  useEffect(() => {
    if (!ro) return;
    if (rootRef.current) ro.observe(rootRef.current);
    if (topRef.current) ro.observe(topRef.current);
    return () => ro.disconnect();
  }, [ro, rootRef]);
  return { topRef, sizes, measure, sheetCb };
}
