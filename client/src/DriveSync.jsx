import { useEffect, useState } from 'react';
import { api, subscribe } from './api.js';

function useDriveSync() {
  const [state, setState] = useState(null);
  useEffect(() => {
    let live = true;
    api.get('/api/sync').then(s => { if (live) setState(s); }).catch(() => {});
    const off = subscribe(m => { if (m.type === 'sync') setState(m.state); });
    return () => { live = false; off(); };
  }, []);
  return [state, setState];
}

export function DriveSyncBadge({ onClick }) {
  const [state] = useDriveSync();
  if (!state?.connected) return null;
  const label = state.phase === 'syncing' ? '云端同步中…' : state.error ? '同步失败' : 'Google Drive';
  return <button className={`btn ghost sync-badge ${state.error ? 'danger' : ''}`} onClick={onClick}
    title={state.error || state.message || '查看 Google Drive 同步设置'}>☁ {label}</button>;
}

export default function DriveSyncSection() {
  const [state, setState] = useDriveSync();
  const [clientId, setClientId] = useState(null);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const locked = busy || state?.phase === 'syncing' || state?.authorizing;
  async function action(fn) {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function saveConfig() {
    const saved = await api.put('/api/sync/config', { clientId: (clientId ?? state.clientId).trim(), ...(secret.trim() ? { clientSecret: secret.trim() } : {}) });
    setState(saved); setClientId(null); setSecret('');
  }
  return <>
    <div className="set-sec">跨端同步 · Google Drive</div>
    <div className="muted small">在各台设备连接同一个 Google 账号，自动同步 PDF、网页、文件夹、笔记、批注和阅读页码。离线编辑会在下次同步时合并；冲突笔记保留副本。API Key 和本机路径保留在当前设备。</div>
    {!state ? <p className="muted small">正在读取同步状态…</p> : <>
      <div className="sync-status" role="status" aria-live="polite">
        <strong>{state.connected ? `已连接：${state.account?.email || state.account?.name || 'Google Drive'}` : state.authorizing ? '等待 Google 授权…' : '尚未连接'}</strong>
        {state.lastSync && <span className="muted small">上次同步：{new Date(state.lastSync).toLocaleString()}</span>}
        {state.message && <span className="small">{state.message}</span>}
      </div>
      {!state.connected && <details className="sync-config" open={!state.clientId}>
        <summary>Google OAuth 配置</summary>
        <p className="muted small">首次配置：在 Google Cloud 项目启用 Drive API，创建「桌面应用」OAuth 客户端，并填入下载的凭据。所有设备需使用同一组客户端凭据。测试模式下请把自己的账号加入测试用户。</p>
        <label className="info-field"><span>Client ID</span><input value={clientId ?? state.clientId} disabled={locked} placeholder="…apps.googleusercontent.com" onChange={e => setClientId(e.target.value)} /></label>
        <label className="info-field"><span>Client secret</span><input type="password" autoComplete="off" value={secret} disabled={locked} placeholder={state.hasClientSecret ? '已保存；留空保持现有配置' : '填入桌面应用凭据中的 client_secret'} onChange={e => setSecret(e.target.value)} /></label>
        <button className="btn" disabled={locked || !(clientId ?? state.clientId).trim()} onClick={() => action(saveConfig)}>保存同步配置</button>
        <p className="muted small">同步存储在 Google Drive 的应用专用空间中，无需选择文件夹，也不会读取其他云盘文件。</p>
      </details>}
      <div className="row wrap sync-actions">
        {!state.connected && !state.authorizing && <button className="btn primary" disabled={locked || !(clientId ?? state.clientId).trim()} onClick={() => action(async () => {
          await saveConfig();
          const result = await api.post('/api/sync/connect');
          setAuthUrl(result.url);
          window.open(result.url, '_blank', 'noopener,noreferrer');
        })}>连接 Google Drive</button>}
        {state.connected && <button className="btn primary" disabled={locked} onClick={() => action(async () => setState(await api.post('/api/sync/run')))}>{state.phase === 'syncing' ? '正在同步…' : '立即同步'}</button>}
        {(state.connected || state.authorizing) && <button className="btn" disabled={busy || state.phase === 'syncing'} onClick={() => action(async () => {
          setState(await api.post('/api/sync/disconnect')); setAuthUrl('');
        })}>{state.authorizing ? '取消登录' : '断开连接'}</button>}
        <label className="sync-auto"><input type="checkbox" checked={state.autoSync} disabled={locked} onChange={e => {
          const autoSync = e.target.checked;
          action(async () => setState(await api.put('/api/sync/config', { autoSync })));
        }} /> 自动同步</label>
      </div>
      {authUrl && state.authorizing && <p className="small">如果浏览器没有打开，<a href={authUrl} target="_blank" rel="noreferrer">点击这里完成 Google 授权</a>。</p>}
      {(error || state.error) && <p className="sync-error small" role="alert">{error || state.error}</p>}
      <p className="muted small">自动同步会在本地修改后触发，并每分钟检查其他设备的改动。关闭应用后暂停；断开连接会保留本地与云端的文库。</p>
    </>}
  </>;
}
