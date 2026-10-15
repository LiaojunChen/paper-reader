import { useCallback, useEffect, useRef, useState } from 'react';

// Pane width in px, persisted per key. Width is clamped to [min, max] and to what the window allows.
// `reserve` = px the rest of the layout needs; the pane never grows past (window width − reserve).
export function usePaneWidth(key, initial, { min = 180, max = 900, reserve = 520 } = {}) {
  const clamp = useCallback(w => {
    const fit = Math.max(min, Math.min(max, window.innerWidth - reserve));
    return Math.round(Math.min(fit, Math.max(min, w)));
  }, [min, max, reserve]);
  const [width, setWidth] = useState(() => {
    const saved = +localStorage.getItem(`pane:${key}`);
    return clamp(saved > 0 ? saved : initial);
  });
  const set = useCallback(w => setWidth(clamp(w)), [clamp]);
  // Saving notifies other panes with the same key (e.g. every open reader tab) so they stay in sync
  const save = useCallback(w => {
    const v = clamp(w);
    localStorage.setItem(`pane:${key}`, String(v));
    window.dispatchEvent(new CustomEvent('pane-width', { detail: { key, width: v } }));
  }, [key, clamp]);
  const reset = useCallback(() => {
    localStorage.removeItem(`pane:${key}`);
    const v = clamp(initial);
    setWidth(v);
    window.dispatchEvent(new CustomEvent('pane-width', { detail: { key, width: v } }));
  }, [key, initial, clamp]);
  useEffect(() => {
    const h = e => { if (e.detail.key === key) setWidth(e.detail.width); };
    // Shrinking the window: re-clamp so panes give the main area room again
    const onResize = () => setWidth(w => clamp(+localStorage.getItem(`pane:${key}`) || w));
    window.addEventListener('pane-width', h);
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('pane-width', h); window.removeEventListener('resize', onResize); };
  }, [key, clamp]);
  return { width, set, save, reset };
}

// Vertical drag handle. side="left": the pane is to the left of the handle (dragging right grows it);
// side="right": the pane is to the right (dragging left grows it). Double-click restores the default.
export default function Splitter({ pane, side = 'left', title = '拖动调整宽度，双击恢复默认' }) {
  const drag = useRef(null);
  const [active, setActive] = useState(false);

  const onPointerDown = e => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Pointer capture keeps the drag alive while the cursor crosses the PDF / iframes
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: pane.width };
    setActive(true);
    document.body.classList.add('is-resizing');
  };
  const onPointerMove = e => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    pane.set(drag.current.w + (side === 'left' ? dx : -dx));
  };
  const end = e => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    pane.save(drag.current.w + (side === 'left' ? dx : -dx));
    drag.current = null;
    setActive(false);
    document.body.classList.remove('is-resizing');
  };
  // Keyboard: focus the handle and use ←/→ (Shift for bigger steps)
  const onKeyDown = e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.shiftKey ? 48 : 16;
    const grow = (e.key === 'ArrowRight') === (side === 'left');
    const w = pane.width + (grow ? step : -step);
    pane.set(w); pane.save(w);
  };
  useEffect(() => () => document.body.classList.remove('is-resizing'), []);

  return (
    <div className={`splitter ${active ? 'active' : ''}`} role="separator" aria-orientation="vertical"
      aria-valuenow={pane.width} tabIndex={0} title={title}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={end} onPointerCancel={end}
      onDoubleClick={() => pane.reset()} onKeyDown={onKeyDown} />
  );
}
