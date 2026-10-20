import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// Right-click menu. Usage:
//   const [menu, openMenu] = useContextMenu();
//   <div onContextMenu={e => openMenu(e, [{ label: '新建笔记', onClick }, '-', { label: '删除', danger: true, onClick }])} />
//   {menu}
// Items: { label, onClick, danger?, disabled? } or '-' for a separator; falsy entries are skipped.
export function useContextMenu() {
  const [state, setState] = useState(null);   // { x, y, items }
  const open = (e, items) => {
    e.preventDefault(); e.stopPropagation();
    setState({ x: e.clientX, y: e.clientY, items: items.filter(Boolean) });
  };
  const menu = state && <ContextMenu {...state} onClose={() => setState(null)} />;
  return [menu, open];
}

function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });
  // Keep the menu inside the window when opened near the right / bottom edge
  useLayoutEffect(() => {
    const r = ref.current.getBoundingClientRect();
    setPos({ left: Math.min(x, innerWidth - r.width - 4), top: Math.min(y, innerHeight - r.height - 4) });
    ref.current.querySelector('button:not(:disabled)')?.focus();
  }, [x, y]);
  useEffect(() => {
    const close = e => { if (!ref.current?.contains(e.target)) onClose(); };
    const key = e => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const btns = [...ref.current.querySelectorAll('button:not(:disabled)')];
        const i = btns.indexOf(document.activeElement);
        btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus();
      }
    };
    window.addEventListener('mousedown', close, true);
    window.addEventListener('contextmenu', close, true);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('contextmenu', close, true);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="ctx-menu" role="menu" style={pos} onContextMenu={e => e.preventDefault()}>
      {items.map((it, i) => it === '-'
        ? <div key={i} className="ctx-sep" role="separator" />
        : <button key={i} role="menuitem" className={it.danger ? 'danger' : ''} disabled={it.disabled}
            onClick={() => { onClose(); it.onClick?.(); }}>{it.label}</button>)}
    </div>
  );
}

// "Show in Finder" vs "Show in Explorer"
export const revealLabel = /Mac/i.test(navigator.platform) ? '在访达中显示' : '在资源管理器中显示';
