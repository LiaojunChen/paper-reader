import { useState } from 'react';
import NoteEditor from './NoteEditor.jsx';

// Stand-alone note window (opened via window.open('/?note=ID'))
export default function NoteWindow({ id }) {
  const [deleted, setDeleted] = useState(false);
  if (deleted) return <div className="pad muted">笔记已删除，可以关闭此窗口。</div>;
  return (
    <div className="note-window">
      <NoteEditor id={id} showOpenWindow={false}
        onTitle={t => { document.title = `${t} · 笔记`; }}
        onDeleted={() => setDeleted(true)}
        onOpenItem={itemId => window.opener?.postMessage({ type: 'open-item', id: itemId }, location.origin)} />
    </div>
  );
}
