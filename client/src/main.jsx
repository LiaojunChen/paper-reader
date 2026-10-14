import { createRoot } from 'react-dom/client';
import 'pdfjs-dist/web/pdf_viewer.css';
import 'katex/dist/katex.min.css';
import './styles.css';
import App from './App.jsx';
import NoteWindow from './NoteWindow.jsx';

// Apply the saved UI scale before first paint (also used by the note window)
const savedScale = +localStorage.getItem('uiScale') || 1;
document.documentElement.style.setProperty('--ui-scale', savedScale);
window.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const cur = +getComputedStyle(document.documentElement).getPropertyValue('--ui-scale') || 1;
  const set = v => {
    const n = Math.min(1.6, Math.max(0.8, +v.toFixed(2)));
    document.documentElement.style.setProperty('--ui-scale', n);
    localStorage.setItem('uiScale', n);
  };
  if (e.key === '=' || e.key === '+') { e.preventDefault(); set(cur + 0.05); }
  else if (e.key === '-') { e.preventDefault(); set(cur - 0.05); }
  else if (e.key === '0') { e.preventDefault(); set(1); }
});

const params = new URLSearchParams(location.search);
const noteId = params.get('note');
createRoot(document.getElementById('root')).render(noteId ? <NoteWindow id={noteId} /> : <App />);
