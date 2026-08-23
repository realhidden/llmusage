import { contextBridge, ipcRenderer } from 'electron';

type InvokeChannel = 'store:snapshot' | 'config:get' | 'config:set' | 'discover:dirs' | 'app:openProject' | 'app:checkUpdate' | 'app:openUpdate' | 'app:quit' | 'app:version';
type EventChannel = 'store:update' | 'error';

const api = {
  invoke(channel: InvokeChannel, args?: unknown): Promise<unknown> {
    return ipcRenderer.invoke(channel, args ?? {});
  },
  subscribe(channel: EventChannel, cb: (msg: unknown) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, msg: unknown) => cb(msg);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
};

contextBridge.exposeInMainWorld('api', api);
