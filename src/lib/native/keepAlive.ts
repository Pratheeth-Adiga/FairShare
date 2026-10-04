import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface KeepAlivePlugin {
  /** Starts the Android foreground service + persistent notification. No-op on web. */
  start(): Promise<{ started: boolean }>;
  /** Stops the foreground service. No-op on web. */
  stop(): Promise<{ stopped: boolean }>;
  isActive(): Promise<{ active: boolean }>;
  // fired when the service stops by itself (Android 15 timeout, start refused)
  addListener(eventName: 'stopped', listener: (data: { reason: string }) => void): Promise<PluginListenerHandle>;
}

// Native (Android) implementation lives at android/app/src/main/java/com/fairshare/app/KeepAlivePlugin.java
// + KeepAliveService.java. The web fallback just tracks a boolean, since browsers
// have no equivalent to an Android foreground service.
const KeepAlive = registerPlugin<KeepAlivePlugin>('KeepAlive', {
  web: () => import('./keepAlive.web').then(m => new m.KeepAliveWeb()),
});

export default KeepAlive;
