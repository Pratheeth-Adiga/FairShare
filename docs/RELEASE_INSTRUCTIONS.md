# Release instructions

These steps produce the web ZIP/tar.gz archives and an Android APK for a GitHub Release.
Run commands from the repository root unless a step says otherwise. Windows examples use
PowerShell. No iOS build is needed for an Android and web release.

## 1. Tools

- Node.js 22.12+ and npm to build the app
- Python 3.10+ on the build machine to package the web archives
- Android Studio, the project's Android SDK, and JDK 21 to build Android
- Git, and optionally GitHub CLI (`gh`) to publish the release

On a fresh checkout, run `npm ci` to restore the locked dependencies.
Archive users only need Node.js 22+; they do not need Python, npm dependencies, or Android tools.

## 2. Set the version

[package.json](../package.json) is the source of truth:

```json
"version": "1.0.0",
"buildNumber": 1
```

- `version`: the user-facing version, Settings display, and web archive names.
  Use `major.minor.patch`, such as `1.0.1`. The current sync script rejects prerelease suffixes.
- `buildNumber`: a positive integer used for Android's version code and iOS's build number.
  Increase it for each published native build. Do not reuse a published build number.

After editing these fields, run:

```powershell
npm run version:sync
```

This updates Android's `versionName`/`versionCode` and both iOS configurations'
`MARKETING_VERSION`/`CURRENT_PROJECT_VERSION`. Commit those updated files with the metadata.
Do not edit the native version fields separately.

The npm web build and native sync/open/run commands also run version sync.
Direct Gradle or Xcode builds do not, so run it yourself before using those tools.
`npm version` invokes the sync hook but does not increase `buildNumber` for you.
If changing the package version manually, keep the root version fields in
[package-lock.json](../package-lock.json) in sync too.

Use a matching GitHub tag, such as `v1.0.1`. Tags are not created automatically.

## 3. Validate the release source

```powershell
npm run typecheck
npm test
python scripts\test-package-web.py
npm run test:e2e
```

The e2e tests need the Playwright browser setup. Investigate failures before publishing.
Commit the intended source changes and make sure the release tag refers to that commit.
Avoid publishing files built from uncommitted changes.

## 4. Create the web ZIP and tar.gz

```powershell
npm run package:web
```

This runs a fresh production build, then
[scripts/package-web.py](../scripts/package-web.py). For version `1.0.0`, output is:

```text
releases\FairShare-web-v1.0.0.zip
releases\FairShare-web-v1.0.0.tar.gz
releases\FairShare-web-v1.0.0-SHA256SUMS.txt
```

Each archive contains one versioned folder with:

```text
FairShare-web-v1.0.0
  public
  server.mjs
  README.txt
```

Only the built web files, the maintained server, and startup instructions are included.
There are no Android/iOS projects, dependencies, source checkout, or user backups.
Output under `releases` is ignored by Git.

Archive ordering, timestamps, and file modes are fixed. Identical inputs produce identical
archives with the same packaging tools. This does not guarantee identical builds across
different Node.js, Python, or compression-library versions.

### Test the extracted package

Extract each archive into a fresh folder. From the extracted app folder:

```powershell
node server.mjs
```

Open `http://localhost:8080`. Check onboarding, Settings version, icons, page refresh on
a nested route, and offline loading after the app has been cached. Stop with Ctrl+C.

The server binds to `127.0.0.1` by default. Optional settings:

```powershell
$env:PORT = '9000'
node server.mjs
```

For access from another device, set `HOST` to `0.0.0.0` and place the server behind an
HTTPS reverse proxy with a trusted certificate. Do not expose plain HTTP directly on the
Internet. A LAN IP over HTTP is not the secure context needed by identity generation and
other browser features; localhost is an exception. Host at the domain root.

This server serves static files, not group data, and provides no WebRTC relay.
Each browser keeps its own data. Changing the host, port, or browser uses separate storage.

### Checksums and signatures

The generated SHA-256 file covers both archives. On Windows, compare it with:

```powershell
Get-FileHash .\releases\FairShare-web-v1.0.0.zip -Algorithm SHA256
Get-FileHash .\releases\FairShare-web-v1.0.0.tar.gz -Algorithm SHA256
```

Checksums detect changed files, but are not publisher signatures. ZIP and tar.gz do not
use Android signing. If publisher signatures are needed, use a separate signing tool,
for example GPG with an existing trusted release key:

```powershell
gpg --armor --detach-sign .\releases\FairShare-web-v1.0.0-SHA256SUMS.txt
gpg --verify .\releases\FairShare-web-v1.0.0-SHA256SUMS.txt.asc .\releases\FairShare-web-v1.0.0-SHA256SUMS.txt
```

Publish the detached signature and the public-key fingerprint through a trusted channel.
GPG is optional and is not installed or configured by the packaging command.

## 5. Prepare Android assets

```powershell
npm run build
npx cap sync android
```

The first command builds fresh production web assets and syncs versions; the second copies
those assets into Android. A Gradle build alone does not rebuild or copy the web app.

### Debug APK for testing

Set JDK 21 for this terminal. Replace the example location if yours is different:

```powershell
$env:JAVA_HOME = 'C:\Program Files\Java\jdk-21'
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
Set-Location android
.\gradlew.bat assembleDebug
Set-Location ..
```

Output: `android\app\build\outputs\apk\debug\app-debug.apk`.
This is automatically debug-signed. It is not the signed release installer.

## 6. Create and sign a release APK

The project does not currently configure Gradle release signing.
Android Studio's signing wizard is the simplest way to generate the signed APK.

1. Complete the version and asset steps above.
2. Run `npm run cap:android` to open Android Studio. Let Gradle sync finish.
3. Under Settings > Build, Execution, Deployment > Build Tools > Gradle, select JDK 21.
   The settings location may vary by Android Studio version.
4. Choose Build > Generate Signed Bundle / APK, then APK > Next.
5. Select your existing release keystore. For a first release, choose Create new:
   - Store the `.jks` outside the repository.
   - Choose strong keystore/key passwords and a key alias.
   - Use a validity of at least 25 years.
   - Back up the keystore, alias, and passwords securely.
6. Enter the keystore password, key alias, and key password.
7. Select the `release` variant and choose an output folder. Keep the recommended signature
   schemes. If an older wizard asks, enable v1 and v2.
8. Finish the wizard and use the build notification's Locate action to find the signed APK.
   A common output folder is `android\app\release`, but use the actual selected location.
9. Give the installer a clear name, such as `FairShare-v1.0.0.apk`.

Never commit the keystore or passwords, attach them to a release, or send them in chat.
The Android ignore file excludes `.jks` and `.keystore`, but keep them outside the repo anyway.
Keep the same signing key for all future direct APK updates. Losing it can prevent users
from updating their installations without uninstalling.

Running `assembleRelease` without signing configuration produces an unsigned APK, not a
distributable signed installer. Do not upload that unsigned output by mistake.

### Verify the signature

Use `apksigner.bat` from the installed Android SDK Build Tools. In PowerShell, replace
the SDK version and APK location:

```powershell
& 'C:\Android\build-tools\<installed-version>\apksigner.bat' verify --verbose --print-certs 'C:\Release\FairShare-v1.0.0.apk'
```

Require a successful exit and compare the signer certificate SHA-256 digest with your
intended release certificate. It must not be the Android debug certificate.
Do not modify APK contents after signing.

Generate a checksum for the final signed APK:

```powershell
Get-FileHash 'C:\Release\FairShare-v1.0.0.apk' -Algorithm SHA256
```

Keep that checksum alongside the web archive checksums when publishing.
Re-running web packaging regenerates its checksum file, so do not rely on manual additions
to that file surviving another packaging run.

### Moving from a debug APK to the signed release

A release-signed APK cannot update a debug-signed app with the same application ID because
their signing certificates differ.

Before uninstalling the debug app:

1. Export the identity file and keep it private; it contains the private key.
2. Export a JSON backup of every group. CSV cannot restore complete groups.
3. Verify the files were saved outside FairShare and are readable.
4. Only then uninstall the debug app and install the signed release.
5. Restore the identity, then import each group JSON and check the balances.

Uninstalling removes local data and Android Keystore keys. A copied app-data folder is not
a substitute for an exported identity backup.
For later same-key release updates, install over the existing app instead of uninstalling.

## 7. Final checks and GitHub Release

- Test both a fresh installation and a same-key upgrade on Android.
- Check identity creation, migration, restart, export/import, and backup-confirmed replacement.
- Connect two devices and verify group data and edits sync in both directions.
- Check launcher icons, splash screens, notification icon, and Settings version.
- Test both extracted web archives and HTTPS hosting if offered.
- Confirm the APK and archives came from the intended committed source.

Create a matching tag and GitHub Release. Attach the signed APK, web ZIP, web tar.gz,
and checksums. Attach the detached checksum signature too if using one.
Include startup requirements, changes, known limitations, and the debug-to-release backup
warning in the release notes.

GitHub also generates source-code ZIP/tar.gz links for the tag. Those contain the full repo,
not the web-only runtime package. Tell users to choose the named `FairShare-web` assets.
