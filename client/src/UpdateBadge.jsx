import { useEffect, useState } from 'react';
import { api, subscribe } from './api.js';

// Update state from the desktop shell (via /api/update + SSE "update" events)
export function useUpdateState() {
  const [s, setS] = useState(null);
  useEffect(() => {
    api.get('/api/update').then(setS).catch(() => {});
    return subscribe(m => { if (m.type === 'update') setS(m.state); });
  }, []);
  return s;
}

// Small pill in the top bar; only visible when there is something to act on
export default function UpdateBadge() {
  const s = useUpdateState();
  if (!s) return null;
  if (s.status === 'downloading') {
    return <span className="update-pill" title={`正在下载 ${s.available}`}>⬇ 更新 {s.progress || 0}%</span>;
  }
  if (s.status === 'downloaded') {
    return (
      <button className="update-pill ready" title={`新版本 ${s.available} 已下载，点击重启完成更新`}
        onClick={() => api.post('/api/update/install')}>⟳ 重启以更新到 {s.available}</button>
    );
  }
  return null;
}

const LABEL = {
  idle: '尚未检查', checking: '正在检查…', latest: '已是最新版本', downloading: '正在下载新版本',
  downloaded: '新版本已下载，重启即可完成更新', error: '检查失败', unsupported: '此版本不能自动更新',
};

// "更新" section of the settings dialog
export function UpdateSection() {
  const s = useUpdateState();
  const [busy, setBusy] = useState(false);
  if (!s) return null;
  const check = async () => { setBusy(true); try { await api.post('/api/update/check'); } finally { setBusy(false); } };
  return (
    <>
      <div className="set-sec">更新</div>
      <div className="update-row">
        <span>当前版本 <b>{s.version || '—'}</b></span>
        <span className="muted">
          {LABEL[s.status] || s.status}
          {s.status === 'downloading' && ` ${s.available} · ${s.progress || 0}%`}
          {s.status === 'error' && `：${s.error}`}
        </span>
      </div>
      {s.status === 'unsupported' && <div className="muted small">{s.reason}</div>}
      <div className="row">
        {s.status !== 'unsupported' && (
          <button className="btn" disabled={busy || s.status === 'checking' || s.status === 'downloading'} onClick={check}>
            {busy || s.status === 'checking' ? '检查中…' : '检查更新'}
          </button>
        )}
        {s.status === 'downloaded' && <button className="btn primary" onClick={() => api.post('/api/update/install')}>重启并更新到 {s.available}</button>}
        {s.status === 'unsupported' && <a className="btn" href="https://github.com/LiaojunChen/paper-reader/releases" target="_blank" rel="noreferrer">打开发布页</a>}
        {s.checkedAt > 0 && <span className="muted small">上次检查：{new Date(s.checkedAt).toLocaleString('zh-CN')}</span>}
      </div>
      <div className="muted small">安装版启动时和每 4 小时自动检查一次，在后台下载，下载完会提示重启。文库、笔记和设置不受影响。</div>
    </>
  );
}
