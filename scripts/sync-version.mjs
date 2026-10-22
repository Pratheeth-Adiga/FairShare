import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function syncVersion(root) {
  const { version, buildNumber } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('version must use major.minor.patch without a prerelease suffix.');
  }
  if (!Number.isInteger(buildNumber) || buildNumber < 1 || buildNumber > 2_100_000_000) {
    throw new Error('buildNumber must be an integer between 1 and 2100000000.');
  }

  const targets = [
    {
      path: join(root, 'android', 'app', 'build.gradle'),
      fields: [
        [/versionName "[^"]*"/g, `versionName "${version}"`, 1],
        [/versionCode \d+/g, `versionCode ${buildNumber}`, 1],
      ],
    },
    {
      path: join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'),
      fields: [
        [/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`, 2],
        [/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${buildNumber};`, 2],
      ],
    },
  ];
  for (const target of targets) {
    target.original = readFileSync(target.path, 'utf8');
    target.updated = target.original;
    for (const [pattern, replacement, count] of target.fields) {
      if ([...target.updated.matchAll(pattern)].length !== count) {
        throw new Error(`Expected ${count} version fields matching ${pattern} in ${target.path}.`);
      }
      target.updated = target.updated.replace(pattern, replacement);
    }
  }
  for (const target of targets) {
    if (target.updated !== target.original) writeFileSync(target.path, target.updated);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  syncVersion(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}
