declare global {
  interface Window {
    api: {
      invoke(channel: string, ...args: unknown[]): Promise<unknown>;
      on(channel: string, callback: (...args: unknown[]) => void): void;
      off(channel: string, callback: (...args: unknown[]) => void): void;
    };
  }
}

export function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  return window.api.invoke(channel, ...args) as Promise<T>;
}

export function on(channel: string, callback: (...args: unknown[]) => void): void {
  window.api.on(channel, callback);
}

export function off(channel: string, callback: (...args: unknown[]) => void): void {
  window.api.off(channel, callback);
}
