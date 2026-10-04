import { describe, it, expect, vi, beforeEach } from 'vitest';

const keepAliveStart = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const keepAliveStop = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const stoppedListener = vi.hoisted(() => ({ value: null as ((data: { reason: string }) => void) | null }));
const keepAliveAddListener = vi.hoisted(() => vi.fn((_event: string, fn: (data: { reason: string }) => void) => {
  stoppedListener.value = fn;
  return Promise.resolve({ remove: vi.fn() });
}));

vi.mock('@/lib/native/keepAlive', () => ({
  default: { start: keepAliveStart, stop: keepAliveStop, addListener: keepAliveAddListener },
}));

const { useSettingsStore } = await import('@/stores/settings.store');

function resetStore() {
  useSettingsStore.setState({
    keepAliveEnabled: false,
    keepAliveError: null,
    theme: 'system',
    isInitialized: false,
  });
}

describe('settings.store', () => {
  beforeEach(() => {
    resetStore();
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    keepAliveStart.mockClear();
    keepAliveStop.mockClear();
  });

  it('initialize picks up the keep-alive flag from localStorage', async () => {
    localStorage.setItem('fairshare-keep-alive-enabled', 'true');

    await useSettingsStore.getState().initialize();

    const s = useSettingsStore.getState();
    expect(s.keepAliveEnabled).toBe(true);
    expect(s.isInitialized).toBe(true);
    // When keep-alive was enabled, initialize must actually start the service.
    expect(keepAliveStart).toHaveBeenCalledTimes(1);
  });

  it('initialize does NOT start the keep-alive service when the flag is off', async () => {
    await useSettingsStore.getState().initialize();
    expect(keepAliveStart).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().isInitialized).toBe(true);
  });

  it('defaults to the system theme when no preference has been saved', async () => {
    await useSettingsStore.getState().initialize();

    expect(useSettingsStore.getState().theme).toBe('system');
    expect(localStorage.getItem('fairshare-theme')).toBeNull();
  });

  it('restores the persisted dark theme and applies it to the document root', async () => {
    localStorage.setItem('fairshare-theme', 'dark');

    await useSettingsStore.getState().initialize();

    expect(useSettingsStore.getState().theme).toBe('dark');
    expect(document.documentElement).toHaveClass('dark');
  });

  it('persists and applies explicit theme changes immediately', () => {
    useSettingsStore.getState().setTheme('dark');
    expect(localStorage.getItem('fairshare-theme')).toBe('dark');
    expect(document.documentElement).toHaveClass('dark');

    useSettingsStore.getState().setTheme('light');
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('persists the system theme option', () => {
    useSettingsStore.getState().setTheme('system');

    expect(useSettingsStore.getState().theme).toBe('system');
    expect(localStorage.getItem('fairshare-theme')).toBe('system');
  });

  it('setKeepAliveEnabled(true) persists and starts the service', async () => {
    await useSettingsStore.getState().setKeepAliveEnabled(true);
    expect(localStorage.getItem('fairshare-keep-alive-enabled')).toBe('true');
    expect(keepAliveStart).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().keepAliveEnabled).toBe(true);
  });

  it('setKeepAliveEnabled(false) persists and stops the service', async () => {
    await useSettingsStore.getState().setKeepAliveEnabled(false);
    expect(localStorage.getItem('fairshare-keep-alive-enabled')).toBe('false');
    expect(keepAliveStop).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().keepAliveEnabled).toBe(false);
  });

  // the toggle used to stay on after start() failed
  it('turns the toggle back off and says why when the native service throws', async () => {
    keepAliveStart.mockRejectedValueOnce(new Error('native error'));
    await expect(
      useSettingsStore.getState().setKeepAliveEnabled(true)
    ).resolves.toBeUndefined();
    expect(useSettingsStore.getState().keepAliveEnabled).toBe(false);
    expect(useSettingsStore.getState().keepAliveError).toBeTruthy();
    expect(localStorage.getItem('fairshare-keep-alive-enabled')).toBe('false');
  });

  // Android stops the service by itself after its daily limit
  it('flips the toggle off when the service reports it stopped', async () => {
    localStorage.setItem('fairshare-keep-alive-enabled', 'true');
    await useSettingsStore.getState().initialize();
    expect(useSettingsStore.getState().keepAliveEnabled).toBe(true);

    stoppedListener.value?.({ reason: 'timeout' });

    expect(useSettingsStore.getState().keepAliveEnabled).toBe(false);
    expect(localStorage.getItem('fairshare-keep-alive-enabled')).toBe('false');
  });
});
