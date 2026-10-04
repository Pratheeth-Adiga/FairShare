import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import KeepAlive from '@/lib/native/keepAlive';

const STORAGE_KEY = 'fairshare-keep-alive-enabled';
const THEME_STORAGE_KEY = 'fairshare-theme';

export type Theme = 'light' | 'dark' | 'system';

let systemThemeQuery: MediaQueryList | null = null;
let removeSystemThemeListener: (() => void) | null = null;

function persistSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    console.error(`[settings] failed to persist ${key}`, err);
  }
}

function applyTheme(theme: Theme): void {
  const useDarkTheme = theme === 'dark'
    || (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', useDarkTheme);
}

function stopFollowingSystemTheme(): void {
  removeSystemThemeListener?.();
  removeSystemThemeListener = null;
  systemThemeQuery = null;
}

function followSystemTheme(): void {
  stopFollowingSystemTheme();
  if (!window.matchMedia) return;
  systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const updateTheme = () => applyTheme('system');
  systemThemeQuery.addEventListener('change', updateTheme);
  removeSystemThemeListener = () => systemThemeQuery?.removeEventListener('change', updateTheme);
}

interface SettingsState {
  keepAliveEnabled: boolean;
  // start() failures used to only reach console.error while the toggle showed on
  keepAliveError: string | null;
  theme: Theme;
  isInitialized: boolean;

  initialize: () => Promise<void>;
  setKeepAliveEnabled: (enabled: boolean) => Promise<void>;
  setTheme: (theme: Theme) => void;
}

let keepAliveListenerAdded = false;

// Keep the toggle local; the disk-backed encryption state is the source of truth.
export const useSettingsStore = create<SettingsState>()(immer((set) => ({
  keepAliveEnabled: false,
  keepAliveError: null,
  theme: 'system',
  isInitialized: false,

  initialize: async () => {
    let stored = false;
    let savedTheme: string | null = null;
    // blocked site storage throws SecurityError here, which used to hang boot
    try {
      stored = localStorage.getItem(STORAGE_KEY) === 'true';
      savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    } catch (err) {
      console.error('[settings] localStorage unavailable, using defaults', err);
    }
    const theme = savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system'
      ? savedTheme
      : 'system';
    set((state) => {
      state.keepAliveEnabled = stored;
      state.theme = theme;
      state.isInitialized = true;
    });
    if (theme === 'system') followSystemTheme();
    applyTheme(theme);
    if (!keepAliveListenerAdded) {
      keepAliveListenerAdded = true;
      // the service stopped by itself, so flip the toggle back off
      KeepAlive.addListener('stopped', ({ reason }) => {
        set((state) => {
          state.keepAliveEnabled = false;
          state.keepAliveError = reason === 'timeout'
            ? 'Android stopped background sync after its daily limit. Turn it on again when you need it.'
            : null;
        });
        persistSetting(STORAGE_KEY, 'false');
      }).catch(err => console.error('[settings] keep-alive listener failed', err));
    }
    if (stored) {
      try {
        await KeepAlive.start();
      } catch (err) {
        console.error('[settings] failed to start keep-alive service', err);
        set((state) => {
          state.keepAliveEnabled = false;
          state.keepAliveError = 'Staying connected in the background is not available on this device.';
        });
      }
    }
  },

  setKeepAliveEnabled: async (enabled) => {
    set((state) => {
      state.keepAliveEnabled = enabled;
      state.keepAliveError = null;
    });
    persistSetting(STORAGE_KEY, String(enabled));
    try {
      if (enabled) {
        await KeepAlive.start();
      } else {
        await KeepAlive.stop();
      }
    } catch (err) {
      console.error('[settings] failed to toggle keep-alive service', err);
      if (enabled) {
        set((state) => {
          state.keepAliveEnabled = false;
          state.keepAliveError = 'Staying connected in the background is not available on this device.';
        });
        persistSetting(STORAGE_KEY, 'false');
      }
    }
  },

  setTheme: (theme) => {
    set((state) => {
      state.theme = theme;
    });
    persistSetting(THEME_STORAGE_KEY, theme);
    if (theme === 'system') {
      followSystemTheme();
    } else {
      stopFollowingSystemTheme();
    }
    applyTheme(theme);
  },
})));
