import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { Invokes } from '../shared/types.js';

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

