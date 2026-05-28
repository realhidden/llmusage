import type { Config, Events, Invokes } from '../shared/types.js';

type Api = {
  invoke<K extends keyof Invokes>(
    channel: K,
    args?: Invokes[K]['req']
  ): Promise<Invokes[K]['res']>;
  subscribe<K extends keyof Events>(
    channel: K,
    cb: (msg: Events[K]) => void
  ): () => void;
};

declare global {
  interface Window {
    api: Api;
    __llmusageConfig?: Config;
  }
}

export {};
