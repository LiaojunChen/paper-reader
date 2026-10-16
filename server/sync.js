import path from 'node:path';
import { GoogleDrive } from './google-drive.js';
import { SyncStore } from './sync-store.js';
import { db, DATA_DIR, FILES_DIR, TEXT_DIR } from './db.js';
import * as vault from './vault.js';

export function createSync(broadcast, noteOut) {
  try { return initializeSync(broadcast, noteOut); }
  catch (e) {
    // Sync is optional. A damaged local sync index must not lock the user out
    // of their offline library or silently reset deletion history.
    const message = `同步初始化失败：${e.message}。请先备份数据目录中的 sync 文件夹`;
    const fail = () => { throw Object.assign(new Error(message), { status: 503 }); };
    return { state: () => ({ connected: false, clientId: '', autoSync: false, phase: 'error', error: message }),
      run: fail, configure: fail, connect: fail, disconnect: fail, schedule() {}, setCredentialCodec() {}, close() {} };
  }
}

function initializeSync(broadcast, noteOut) {
  let phase = 'idle', message = '', lastError = '', active = null, changeTimer;
  const store = new SyncStore({ db, dataDir: DATA_DIR, filesDir: FILES_DIR, textDir: TEXT_DIR,
    vaultDir: vault.getVaultDir, invalidate: vault.invalidateVault,
    onApplied(changed, values) {
      broadcast({ type: 'tree' }); broadcast({ type: 'items' });
      for (const key of changed) {
        if (key.startsWith('vault/') && /\.md$/i.test(key)) {
          const id = key.slice(6);
          if (values[key]) broadcast({ type: 'note', note: noteOut(vault.readNote(id)), origin: 'sync' });
          else broadcast({ type: 'note-deleted', id, origin: 'sync' });
        }
      }
      broadcast({ type: 'sync-applied' });
    } });
  const drive = new GoogleDrive(path.join(DATA_DIR, 'sync'), () => {
    emit();
    if (drive.status().connected && drive.status().autoSync) schedule(1000);
  });
  drive.status(); // Validate persisted credential JSON while initialization can fall back safely.
  const state = () => ({ ...drive.status(), phase, message, error: lastError, lastSync: store.state.lastSync || null });
  const emit = () => broadcast({ type: 'sync', state: state() });
  async function run() {
    if (active) return active;
    if (!drive.status().connected) throw Object.assign(new Error('请先连接 Google Drive'), { status: 401 });
    clearTimeout(changeTimer);
    changeTimer = null;
    drive.active = true; phase = 'syncing'; lastError = ''; emit();
    active = store.sync(drive, text => { message = text; emit(); }).then(result => {
      phase = 'idle'; message = result.conflicts ? `同步完成，${result.conflicts} 个冲突版本已保留副本` : '同步完成';
      return result;
    }).catch(e => { phase = 'error'; lastError = e.message; message = ''; throw e; })
      .finally(() => { active = null; drive.active = false; emit(); });
    return active;
  }
  function schedule(delay = 4000) {
    if (!drive.status().connected || !drive.status().autoSync || changeTimer) return;
    changeTimer = setTimeout(() => {
      changeTimer = null;
      if (active) return schedule();
      run().catch(() => {});
    }, delay);
    changeTimer.unref();
  }
  const interval = setInterval(() => schedule(1000), 60000);
  interval.unref();
  const startup = setTimeout(() => schedule(1000), 3000);
  startup.unref();
  return {
    state, run, schedule,
    setCredentialCodec: codec => drive.setCodec(codec),
    configure: patch => {
      const s = drive.configure(patch);
      if (!s.autoSync) { clearTimeout(changeTimer); changeTimer = null; }
      return state();
    },
    connect: () => drive.beginAuth(binding => {
      if (store.state.binding === binding && store.state.vault && store.state.vault !== path.resolve(vault.getVaultDir())) store.state.binding = '';
      store.bind(binding);
      phase = 'idle'; lastError = ''; message = 'Google Drive 已连接';
    }, e => { phase = 'error'; lastError = e.message; emit(); }),
    disconnect: () => { drive.disconnect(); clearTimeout(changeTimer); changeTimer = null; phase = 'idle'; lastError = ''; message = ''; emit(); return state(); },
    close: () => { clearInterval(interval); clearTimeout(startup); clearTimeout(changeTimer); drive.cancelAuth(); },
  };
}
