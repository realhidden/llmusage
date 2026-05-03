import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { Invokes, Events } from '../shared/types.js';
import type { BrowserWindow } from 'electron';

type InvokeHandler<K extends keyof Invokes> = (
  event: IpcMainInvokeEvent,
  args: Invokes[K]['req']
) => Promise<Invokes[K]['res']> | Invokes[K]['res'];

type InvokeMap = {
  [K in keyof Invokes]: InvokeHandler<K>;
};

export function registerIPC(
  ipcMain: IpcMain,
  handlers: Partial<InvokeMap>
): void {
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, args) => handler(event, args));
  }
}

export function broadcast<K extends keyof Events>(
  windows: BrowserWindow[],
  channel: K,
  payload: Events[K]
): void {
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}
