import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import App from '@/App';
import { SettingsPage } from '@/pages/Settings';
import { useIdentityStore } from '@/stores/identity.store';
import { useGroupsStore } from '@/stores/groups.store';
import { useSettingsStore } from '@/stores/settings.store';
import { generateIdentity } from '@/lib/crypto/identity';
import { exportIdentityToJSON, downloadTextFile } from '@/lib/io/backup';
import type { UserIdentity } from '@/types';

vi.mock('../../../package.json', () => ({ version: '9.8.7' }));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
    getLaunchUrl: vi.fn(async () => undefined),
  },
}));

vi.mock('@/lib/io/backup', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/io/backup')>(),
  downloadTextFile: vi.fn(async () => 'Export ready'),
}));

const identityState = useIdentityStore.getState();
const groupsState = useGroupsStore.getState();
const settingsState = useSettingsStore.getState();
const restoreIdentity = vi.fn(async () => {});
const identityForExport = vi.fn(async () => current);
let current: UserIdentity;
let imported: UserIdentity;

beforeAll(async () => {
  current = await generateIdentity('Current');
  imported = await generateIdentity('Restored');
});

beforeEach(() => {
  vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
  restoreIdentity.mockClear();
  identityForExport.mockReset().mockImplementation(async () => current);
  vi.mocked(downloadTextFile).mockClear();
  useIdentityStore.setState({
    ...identityState,
    identity: current,
    initialize: async () => {},
    resumePendingProfileUpdate: async () => {},
    restoreIdentity,
    identityForExport,
  });
  useGroupsStore.setState({ initialize: async () => {} });
  useSettingsStore.setState({ initialize: async () => {} });
});

afterEach(() => {
  vi.restoreAllMocks();
  useIdentityStore.setState(identityState, true);
  useGroupsStore.setState(groupsState, true);
  useSettingsStore.setState(settingsState, true);
});

async function confirmBackupSaved() {
  const saved = await screen.findByRole('checkbox', { name: 'I saved the backup file outside FairShare' });
  expect(restoreIdentity).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Replace identity' })).toBeDisabled();
  fireEvent.click(saved);
  fireEvent.click(screen.getByRole('button', { name: 'Replace identity' }));
}

it('shows the version from package metadata in Settings', () => {
  render(<MemoryRouter><SettingsPage /></MemoryRouter>);
  expect(screen.getByText('FairShare v9.8.7')).toBeInTheDocument();
});

async function stageSettingsImport() {
  render(<MemoryRouter><SettingsPage /></MemoryRouter>);
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(picker, {
    target: { files: [new File([exportIdentityToJSON(imported)], 'identity.json')] },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Replace identity' }));
}

describe.each(['settings', 'recovery'] as const)('%s identity file import', surface => {
  async function renderPicker() {
    if (surface === 'settings') {
      render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    } else {
      useIdentityStore.setState({ identity: null, needsPassphrase: true });
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: 'Forgot passphrase?' }));
    }
    return document.querySelector<HTMLInputElement>('input[type="file"]')!;
  }

  it.each(['application/json', 'text/plain', 'application/octet-stream', ''])(
    'accepts a valid export reported as "%s"',
    async type => {
      const picker = await renderPicker();
      expect(picker).toHaveAttribute('accept', '*/*');
      fireEvent.change(picker, {
        target: { files: [new File([exportIdentityToJSON(imported)], 'identity.json', { type })] },
      });

      if (surface === 'settings') {
        expect(await screen.findByRole('dialog', { name: 'Replace your identity?' })).toBeInTheDocument();
        expect(restoreIdentity).not.toHaveBeenCalled();
        expect(downloadTextFile).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Replace identity' }));
        await waitFor(() => expect(downloadTextFile).toHaveBeenCalledWith(
          `fairshare-identity-backup-${current.peerId}.json`,
          expect.any(String),
          'application/json',
        ));
        const backup = JSON.parse(vi.mocked(downloadTextFile).mock.calls[0][1]);
        expect(backup.identity).toEqual(current);
        await confirmBackupSaved();
      }
      await waitFor(() => expect(restoreIdentity).toHaveBeenCalledWith(imported));
      if (surface === 'settings') {
        expect(downloadTextFile).toHaveBeenCalledTimes(1);
        expect(vi.mocked(downloadTextFile).mock.invocationCallOrder[0])
          .toBeLessThan(restoreIdentity.mock.invocationCallOrder[0]);
      }
      expect(picker.value).toBe('');
    },
  );

  it('keeps a JSON filter in the browser', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    expect(await renderPicker()).toHaveAttribute('accept', '.json,application/json');
  });

  it('can restore an older export whose filename lost its extension', async () => {
    const picker = await renderPicker();
    fireEvent.change(picker, {
      target: { files: [new File([exportIdentityToJSON(imported)], 'fairshare-identity-peer-abc')] },
    });
    if (surface === 'settings') {
      expect(await screen.findByRole('dialog', { name: 'Replace your identity?' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Replace identity' }));
      await confirmBackupSaved();
    }
    await waitFor(() => expect(restoreIdentity).toHaveBeenCalledWith(imported));
  });

  it.each([
    ['not json', 'That file is not valid JSON.'],
    ['{}', 'This file does not contain a valid FairShare identity export'],
  ])('rejects invalid contents: %s', async (contents, message) => {
    const picker = await renderPicker();
    fireEvent.change(picker, {
      target: { files: [new File([contents], 'identity.json', { type: 'application/octet-stream' })] },
    });
    expect(await screen.findByText(message, { exact: false })).toBeInTheDocument();
    expect(restoreIdentity).not.toHaveBeenCalled();
    expect(downloadTextFile).not.toHaveBeenCalled();
  });

  it('rejects keys that do not match', async () => {
    const picker = await renderPicker();
    const mismatched = { ...imported, privateKey: current.privateKey };
    fireEvent.change(picker, {
      target: { files: [new File([exportIdentityToJSON(mismatched)], 'identity.json')] },
    });
    expect(await screen.findByText(/The keys in this file do not belong together/)).toBeInTheDocument();
    expect(restoreIdentity).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

it('still warns before exporting a passphrase-protected identity as plaintext', () => {
  useIdentityStore.setState({ isEncryptedOnDisk: true });
  render(<MemoryRouter><SettingsPage /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Export Identity' }));
  expect(screen.getByRole('dialog')).toHaveTextContent(/unencrypted/);
  expect(downloadTextFile).not.toHaveBeenCalled();
});

it('shows native protection without an off switch and warns before retrieving an export', async () => {
  useIdentityStore.setState({ isEncryptedOnDisk: true, isNativeProtectedOnDisk: true });
  render(<MemoryRouter><SettingsPage /></MemoryRouter>);
  expect(screen.getByText('Identity Protection')).toBeInTheDocument();
  expect(screen.queryByRole('checkbox', { name: 'Encrypt private key at rest' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Export Identity' }));
  expect(identityForExport).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Export anyway' }));
  await waitFor(() => expect(downloadTextFile).toHaveBeenCalled());
  expect(identityForExport).toHaveBeenCalledTimes(1);
});

it.each(['Export Identity', 'Show QR Code'])('does not use the session key when %s retrieval fails', async button => {
  useIdentityStore.setState({ isEncryptedOnDisk: true, isNativeProtectedOnDisk: true });
  identityForExport.mockRejectedValueOnce(new Error('Device key unavailable'));
  render(<MemoryRouter><SettingsPage /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: button }));
  expect(identityForExport).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', {
    name: button === 'Export Identity' ? 'Export anyway' : 'I understand, show it',
  }));
  expect(await screen.findByText(/Device key unavailable/)).toBeInTheDocument();
  expect(downloadTextFile).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog', { name: 'Scan this on your other device' })).not.toBeInTheDocument();
});

it('blocks replacement if the current native identity cannot be retrieved for backup', async () => {
  identityForExport.mockRejectedValueOnce(new Error('Device key unavailable'));
  render(<MemoryRouter><SettingsPage /></MemoryRouter>);
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(picker, {
    target: { files: [new File([exportIdentityToJSON(imported)], 'identity.json')] },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Replace identity' }));
  await waitFor(() => expect(identityForExport).toHaveBeenCalled());
  expect(restoreIdentity).not.toHaveBeenCalled();
  expect(downloadTextFile).not.toHaveBeenCalled();
});

it('asks for a saved backup when Android reports the share sheet as cancelled', async () => {
  vi.mocked(downloadTextFile).mockRejectedValueOnce(new Error('Share canceled'));
  await stageSettingsImport();
  expect(await screen.findByText(/The share sheet says it was closed/)).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByText(/Could not back up/)).not.toBeInTheDocument();

  await confirmBackupSaved();
  await waitFor(() => expect(restoreIdentity).toHaveBeenCalledWith(imported));
  expect(downloadTextFile).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('does not replace after a real cancel unless the backup is confirmed', async () => {
  vi.mocked(downloadTextFile).mockRejectedValueOnce(new Error('Share canceled'));
  await stageSettingsImport();
  const replace = await screen.findByRole('button', { name: 'Replace identity' });
  await waitFor(() => expect(replace).toBeDisabled());
  fireEvent.click(replace);

  fireEvent.click(screen.getByRole('button', { name: 'Share backup again' }));
  await waitFor(() => expect(downloadTextFile).toHaveBeenCalledTimes(2));
  expect(await screen.findByText(/can't tell FairShare if the backup was actually saved/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(restoreIdentity).not.toHaveBeenCalled();
});

it('blocks replacement when the backup file cannot be written', async () => {
  vi.mocked(downloadTextFile).mockRejectedValueOnce(new Error('Storage unavailable'));
  await stageSettingsImport();
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not back up current identity: Storage unavailable');
  expect(screen.queryByRole('checkbox', { name: 'I saved the backup file outside FairShare' })).not.toBeInTheDocument();
  expect(restoreIdentity).not.toHaveBeenCalled();
});

it('replaces right after the browser download without asking', async () => {
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
  await stageSettingsImport();
  await waitFor(() => expect(restoreIdentity).toHaveBeenCalledWith(imported));
  expect(downloadTextFile).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('checkbox', { name: 'I saved the backup file outside FairShare' })).not.toBeInTheDocument();
});

it('shows a closed share sheet on Export Identity as a note, not an error', async () => {
  vi.mocked(downloadTextFile).mockRejectedValueOnce(new Error('Share canceled'));
  render(<MemoryRouter><SettingsPage /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Export Identity' }));
  expect(await screen.findByText(/Share sheet closed/)).toBeInTheDocument();
  expect(screen.queryByText(/Could not export identity/)).not.toBeInTheDocument();
});

it('offers a confirmed backup restore after a secure-storage boot error', async () => {
  useIdentityStore.setState({ identity: null, loadError: 'Keychain unavailable' });
  render(<App />);
  expect(await screen.findByText("Couldn't load your identity")).toBeInTheDocument();
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  expect(picker).toHaveAttribute('accept', '*/*');
  fireEvent.change(picker, {
    target: { files: [new File([exportIdentityToJSON(imported)], 'identity.json')] },
  });
  const confirm = await screen.findByRole('button', { name: 'Confirm restore' });
  expect(restoreIdentity).not.toHaveBeenCalled();
  fireEvent.click(confirm);
  await waitFor(() => expect(restoreIdentity).toHaveBeenCalledWith(imported));
});
