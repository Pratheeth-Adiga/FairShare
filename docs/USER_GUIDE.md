# FairShare: User Guide

## What is FairShare?

FairShare is a private, serverless expense-splitting app. Track shared costs with friends, roommates, or travel companions with no accounts, no cloud, and no subscriptions. Your data stays on your device and syncs directly with your friends' devices.

---

## System Requirements

### Android
- **Minimum OS version**: Android 7.0 (API 24) or newer
- **Android System WebView**: must be kept up to date via Play Store. FairShare's peer-to-peer connection relies on WebRTC support in the device's WebView, and very old/stale builds (version ~68 from 2018 has been observed in the wild) fail to gather network candidates at all, causing "Connection timed out" errors during peer setup even though the app itself installs and runs fine.
  - Check for updates: Play Store → search "Android System WebView" → Update if available
  - If no update is offered, enable Developer Options (Settings → About phone → tap "Build number" 7 times) → Developer Options → **WebView implementation** → switch to "Chrome" if a modern Chrome browser is installed
  - Recommended: WebView/Chrome version 90 or newer for reliable P2P connections

### Desktop / Other Browsers
- Any modern browser with WebRTC support: Chrome, Firefox, Safari 15+, Edge

### iOS
- iOS 15+ recommended (WebKit's built-in WebRTC support)

---

## Getting Started

### First Launch

When you open FairShare for the first time, you'll be asked to enter a display name. This is how others will see you in shared groups. A unique device identity is generated automatically (no email or password needed).

<img src="assets/screenshots/onboarding.png" alt="Onboarding screen" width="320">

Once you're set up, the Dashboard starts empty until you create or join a group:

<img src="assets/screenshots/dashboard-empty.png" alt="Empty dashboard" width="320">

### Creating a Group

1. From the Dashboard, tap **"Create Group"**
2. Enter a group name (e.g., "Trip to Paris", "Apartment")
3. Choose a default currency
4. You're added as the first member automatically

<img src="assets/screenshots/create-group.png" alt="Create Group dialog" width="320">

Once created, the group appears on your Dashboard along with your overall balance across all groups:

<img src="assets/screenshots/dashboard.png" alt="Dashboard with a group" width="320">

### Adding Members

In any group, tap **"Add"** next to the Members heading:
- Enter the person's name
- They'll appear as a member immediately
- They can later connect their own device to sync (see Connecting Devices below)

> **Note:** a manually-added member is just a name placeholder with no device of its own. If
> that person later connects their own device (via the QR flow), the app currently has no way
> to recognize "this is the same person". It adds them as a **second, separate member**
> instead of merging into the placeholder, since the placeholder was never a real identity to
> begin with. If you know someone will connect their own device, it's cleaner to let them join
> via QR directly rather than adding them manually first.

<img src="assets/screenshots/group-detail-members.png" alt="Group with members added" width="320">

### Managing Members

Open **"Manage Members"** from the group to:
- **Remove a member**: if they have expenses tied to them, you're asked to reassign those
  expenses to another member first so no expense is left pointing at nobody
- **Introduce a peer**: if you're connected to someone who isn't directly connected to another
  member of the group, you can ask an already-connected peer to relay the signaling handshake
  ("introduction") so the two of them can connect without a fresh QR exchange

---

## Core Features

### Adding an Expense

1. Open a group and tap the **+** button (bottom right)
2. Fill in:
   - **Description**: What was the expense for
   - **Amount**: Total cost
   - **Date**
   - **Paid by**: Who paid. Check **"Multiple payers"** if more than one person fronted the
     money (e.g. two people split paying the bill before splitting it among the group) and
     enter how much each of them paid
   - **Categories**: Food, transport, accommodation, etc. - pick one or more; groups can also
     define their own custom categories (see Group Settings below)
   - **Split between**: Select which members share this cost
   - **Split type**: How to divide it (see Split Types below)
3. Tap **"Add Expense"**

<img src="assets/screenshots/add-expense.png" alt="Add Expense form" width="320">

### Split Types

| Type | How it works | Best for |
|------|-------------|----------|
| **Equal** | Divides evenly among selected members | Most situations |
| **Exact** | You enter the exact amount each person owes | Restaurant bills where everyone ordered differently |
| **Percentage** | Each person pays a percentage of the total | Income-proportional splits |
| **Shares** | Each person gets a number of shares (e.g., a couple gets 2 shares) | Families or couples sharing with singles |
| **Weights** | Like shares, but with arbitrary decimal weights | Fine-grained proportional splits |

### Expense Details, Comments & Edit History

Open an expense (tap it in the group's expense list) to see the full payer/split breakdown,
and:
- **Comments**: leave a note on an expense for other members to see (e.g. "this included
  Priya's drinks too"); you can delete your own comments
- **Edit history**: every edit to an expense (amount, split, description, etc.) is recorded with
  who changed it and when, so the group can see what changed after the fact

### Viewing Balances

The group page shows a **Balances** section with simplified debts:
- "Alice owes Bob Rs.25.00" means one direct payment settles them
- The app automatically simplifies complex debts (A owes B who owes C becomes A owes C directly)

<img src="assets/screenshots/group-detail-balances.png" alt="Group balances and expenses" width="320">

### Settling Up

1. In a group, tap **"Settle Up"**
2. Choose a suggested settlement or enter a custom amount
3. Record who paid whom and how much
4. The balance updates immediately

<img src="assets/screenshots/settle-up.png" alt="Settle Up screen" width="320">

### Archiving or Deleting a Group

Open the group and tap the **gear icon** (top right) to open Settings:
- **Archive Group**: marks the group inactive without deleting anything - its data, balances
  and history stay intact and it stops showing up as an active group. Useful for a trip or
  event that's over but you still want to keep the record.
- **Delete Group**: tap **"Delete Group"**, confirm, and the group and all its expenses are
  permanently removed. This cannot be undone.

---

## Connecting Devices (P2P Sync)

FairShare syncs directly between devices with no server involved. Two devices connect by exchanging QR codes (or text blobs) one time. After that, they sync automatically whenever both are online.

### Connecting to a Friend (You Initiate)

1. Open a group, tap **"Connect Peer"** or the Wifi icon in the header
2. Wait ~3 seconds while your device prepares connection info
3. A QR code and text blob appear. Show or send this to your friend
4. Tap **"I've shared it: scan their response"**
5. Scan your friend's response QR code (or paste their text)
6. Connected! Data syncs automatically

### Joining a Friend (They Initiated)

1. Open the same group, tap **"Scan to Join"**
2. Scan your friend's QR code (or tap "Paste code instead" and paste their text)
3. Wait ~3 seconds while your device prepares a response
4. Show your response QR code back to your friend (or send the text)
5. Once they scan it, you're connected!

### Connection Status

The **peer badge** next to the Members heading shows:
- "No peers": not connected to anyone
- "1 peer" / "2 peers": actively connected and syncing

### When Connection Fails

If devices can't connect directly (common on mobile data or corporate networks):
- Try connecting while both devices are on the **same WiFi network**
- Use the **copy/paste** method if QR scanning is difficult
- Connection works best on home WiFi networks

---

## History

The **History** tab lists every expense across all your groups, newest first, with a search box
that filters by description or category. It's virtualized, so it stays fast even with a large
number of expenses.

## Statistics

The **Stats** tab shows:
- **Total Paid**: Everything you've paid across all groups
- **Your Share**: Your fair share of all group expenses
- **Net Balance**: Whether you're owed money or owe others overall
- **Most Spent With**: Top 5 people you share the most expenses with, ranked by total amount
- **Spending by Category**: Breakdown of where money goes (food, transport, etc.)

> **Note on multiple currencies:** these personal totals add up raw amounts across every group
> you're in, without currency conversion. If all your groups use the same currency this is fine;
> if you're in groups with different currencies (e.g. one USD, one INR), the combined totals mix
> them together as if they were the same unit. Treat this page as approximate in that case.
> Per-group figures (inside each group, and each group's own Stats page) are always correct and
> shown in that group's actual currency.

<img src="assets/screenshots/stats.png" alt="Statistics page" width="320">

---

## Settings

### Group Settings (gear icon in group)
- **Default Currency**: Change the group's currency (USD, EUR, GBP, INR, JPY, CAD, AUD). Locked
  once the group has expenses, since balances add up every expense in one currency.
- **Default Split Type**: Set whether new expenses default to equal, exact, percentage, shares, or weights
- **Simplify Debts**: When enabled, complex chains of debts are reduced to fewer direct payments
- **Categories**: Remove categories you don't use, or add your own custom categories specific to this group
- **Backup & Export**: Export the group as JSON (all expenses, members, and settings; can be
  re-imported here or on another device) or as CSV (expenses only, for spreadsheets). Import a
  previously exported JSON file to restore or merge a group.
- **Archive Group** / **Delete Group**: see "Archiving or Deleting a Group" above

### App Settings (Settings tab)
- **Display Name**: Change how others see you
- **Identity**: Your unique device ID and public key (for debugging)
- **Backing up your identity**: Your identity (display name + keypair) is what lets other
  devices recognize you across groups. Back it up so you can move to a new device or restore
  after reinstalling:
  - **Export Identity**: downloads a JSON file in a browser, or opens the share sheet in the
    mobile app so you can save it. It contains your unencrypted private key, even with
    device or passphrase protection enabled. Keep it private, anyone with it can act as you.
    Android sometimes says the share sheet was closed even when an app like Files or Drive
    saved the file, so check the file is there before you rely on it.
  - **Restore Identity**: select your exported `fairshare-identity-....json` file. The mobile
    picker shows all file types because Android may label JSON files as text or generic files.
    Older identity exports may have no `.json` ending; those can still be selected in the app.
    FairShare checks the contents and keys before restoring. In Settings, you confirm the
    replacement and a backup of your current identity is exported first. In the mobile app the
    phone can't tell FairShare if that backup really got saved, so after the share sheet you tick
    **I saved the backup file outside FairShare** before **Replace identity** works. If you
    cancelled, use **Share backup again**. If the backup file can't be made at all, the
    replacement is blocked.
    On a new install, finish the name setup, then open Settings to restore.
    If locked out, use **Forgot passphrase?** → **Restore identity from a backup file** instead.
    If device protection cannot load your key, the error screen also offers a confirmed
    backup restore. Try unlocking the phone and tapping Retry first.
    **Start over with a new identity** is also available there, with a separate confirmation.
    It keeps your groups but deletes the current identity, so use a backup instead if you have one.
  - **Show QR Code** / **Scan Identity QR**: transfer an identity directly between two devices
    without a file, e.g. moving to a new phone. Both directions show a warning first since the
    QR contains your private key.
- **Key Encryption (browser)**: Encrypt your private key at rest with a passphrase, instead of storing it
  in plain text in local storage. Once enabled, you'll need your passphrase each time you open
  the app; if you forget it, **Forgot passphrase?** lets you restore an identity backup or
  start over with a new identity (you'll need to re-establish connections with peers).
- **Identity Protection (native)**: New and restored identities use device protection by default.
  Android wraps your identity private key with a nonexportable Android Keystore key.
  iOS stores the retrievable identity key in Keychain, available while the device is unlocked,
  on this device only, without iCloud sync. Neither platform requires biometrics.
  Android access does not require a screen-unlock or biometric check for each read.
  The identity key itself remains exportable and is held in memory while FairShare is running.
  This protects the stored private key, not group data or exported backups.
  - Existing unencrypted native identities move to device protection at startup. FairShare checks
    that it can read the protected key before replacing the old storage row. A storage error
    stops startup with a retry screen; it does not create a new identity or save a plaintext key.
  - Existing passphrase-encrypted identities keep their passphrase, including after unlocking.
    **Use device protection** asks for that passphrase before switching. If the switch fails,
    the passphrase-protected copy stays in place.
  - Importing a JSON backup or scanning an identity QR protects the key on the destination phone.
    Browser imports keep the existing browser behavior; enable Key Encryption there if wanted.
  - Keep an exported identity backup before reinstalling or moving phones. Native protection
    is device-bound, so copying app storage to another phone is not an identity backup.
    File and QR exports still contain the plain private key and keep their confirmation warnings.
- **Theme**: Switch between System, Light, and Dark appearance.
- **Persistent Connection**: A toggle to help FairShare keep syncing while backgrounded or the
  screen is locked.
  - **Android**: shows an ongoing notification and keeps the app connected to peers continuously
    while backgrounded/locked.
  - **iOS**: Apple does not allow apps to run continuously in the background, so this only gives
    an in-progress sync a few extra seconds to finish before the connection is suspended. It is
    not a substitute for opening the app to sync.
  - **Browser (not installed as an app)**: unavailable; install the Android or iOS app to use it.

<img src="assets/screenshots/settings.png" alt="Settings page" width="320">

---

## How Data Works

### Privacy
- All data is stored **only on your device** (in the browser's IndexedDB)
- Sync happens **directly between devices** (peer-to-peer WebRTC)
- No data ever touches a server
- No analytics, no tracking, no accounts
- To find a route between two phones, the app asks public STUN servers (Cloudflare, Google and
  Twilio by default) what your public IP address is. Those servers see your IP and that you're
  using WebRTC, nothing about your groups or expenses.

### Persistence
- Data persists across browser sessions (stored in IndexedDB)
- Closing the tab does NOT delete your data
- Clearing browser data WILL delete your data
- Install as a PWA (Add to Home Screen) for the most app-like experience

### Sync Behavior
- Changes sync in real-time when peers are connected
- If you add an expense while offline, it syncs next time you connect
- Multiple tabs on the same device sync instantly via BroadcastChannel

---

## Tips

- **Install as PWA**: On mobile, use "Add to Home Screen" for fullscreen mode and faster loading
- **Use copy/paste for remote friends**: If you can't scan QR codes in person, copy the connection text and send it via any messaging app
- **One group per trip/context**: Create separate groups for different purposes (one for a trip, one for roommates, one for a dinner)
- **Settle regularly**: Record settlements as you make them to keep balances accurate
- **Reconnecting**: if both devices stay on the same network without the app being fully closed
  (e.g. phone screen locks, brief WiFi drop), the connection resumes automatically. Once the
  connection actually drops for good (app closed a while, network changed, other device restarted),
  WebRTC's session credentials expire and there's no way to silently revive it. You will need to
  redo the QR/text exchange once. There's no persistent pairing that survives that.

---

## FAQ

**Q: What happens if I lose my phone?**
A: Your data is on that device only. If another connected peer has synced with you, they'll still have the shared group data. There's no cloud backup currently.

**Q: Can I use this on desktop and mobile?**
A: Yes! Open the app in any modern browser. Connect your devices using the QR code flow to keep them in sync.

**Q: Do both devices need to be online at the same time?**
A: For syncing, yes: WebRTC requires both devices to be online simultaneously. Changes made offline will sync next time both are connected.

**Q: Is there a limit to group size?**
A: No hard limit, but the app is optimized for small groups (2-15 people). Very large groups may experience slower sync.

**Q: Can I export my data?**
A: Yes. Open a group's Settings (gear icon) and use **Export JSON** (full backup, re-importable)
or **Export CSV** (expenses only, for spreadsheets). Your identity itself can also be backed up
separately from the app Settings tab (see "Backing up your identity" above).

**Q: What browsers are supported?**
A: Any modern browser with WebRTC support: Chrome, Firefox, Safari 15+, Edge. Works on both desktop and mobile.
