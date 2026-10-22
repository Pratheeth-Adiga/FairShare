import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let root: string;
let android: string;
let ios: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fairshare-version-'));
  android = join(root, 'android', 'app', 'build.gradle');
  ios = join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'android', 'app'), { recursive: true });
  mkdirSync(join(root, 'ios', 'App', 'App.xcodeproj'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'sync-version.mjs'), readFileSync('scripts/sync-version.mjs'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '2.3.4', buildNumber: 27 }));
  writeFileSync(android, 'versionName "1.0"\r\nversionCode 1\r\n');
  writeFileSync(ios, 'MARKETING_VERSION = 1.0;\nCURRENT_PROJECT_VERSION = 1;\n'.repeat(2));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runSync() {
  execFileSync(process.execPath, [join(root, 'scripts', 'sync-version.mjs')], { stdio: 'pipe' });
}

describe('centralized app version', () => {
  it('updates Android and both iOS configurations and preserves line endings', () => {
    runSync();
    expect(readFileSync(android, 'utf8')).toBe('versionName "2.3.4"\r\nversionCode 27\r\n');
    expect(readFileSync(ios, 'utf8')).toBe('MARKETING_VERSION = 2.3.4;\nCURRENT_PROJECT_VERSION = 27;\n'.repeat(2));
    runSync();
    expect(readFileSync(android, 'utf8')).toBe('versionName "2.3.4"\r\nversionCode 27\r\n');
  });

  it.each([
    { version: '2.0.0-beta.1', buildNumber: 1 },
    { version: '2.0.0', buildNumber: 0 },
    { version: '2.0.0', buildNumber: 1.5 },
    { version: '2.0.0', buildNumber: 2_100_000_001 },
    { version: '2.0.0' },
  ])('rejects invalid metadata without changing native files: %j', metadata => {
    writeFileSync(join(root, 'package.json'), JSON.stringify(metadata));
    expect(runSync).toThrow();
    expect(readFileSync(android, 'utf8')).toContain('versionName "1.0"');
    expect(readFileSync(ios, 'utf8')).toContain('MARKETING_VERSION = 1.0;');
  });

  it('does not update Android when iOS version fields are missing', () => {
    writeFileSync(ios, 'unrelated settings');
    expect(runSync).toThrow();
    expect(readFileSync(android, 'utf8')).toContain('versionName "1.0"');
  });
});
