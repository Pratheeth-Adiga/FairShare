# FairShare

A serverless, peer-to-peer expense splitting PWA. No accounts, no cloud: just direct device-to-device sync via WebRTC.

## Quick Start

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in your browser.

## Build

```bash
npm run build    # TypeScript check + production build
npm run preview  # Serve the production build locally
```

## Test

```bash
npm test         # Run Vitest
```

## Native builds (Android / iOS)

This is also a native Android/iOS app via [Capacitor](https://capacitorjs.com) - the `android/`
and `ios/` folders are full native projects, not just config.

```bash
npm run cap:build          # web build + cap sync
npm run cap:android        # open the Android project in Android Studio
npm run cap:ios            # open the iOS project in Xcode (macOS only)
npm run cap:run:android    # build + run on a connected device/emulator
```

## Documentation

- **[User Guide](docs/USER_GUIDE.md)**: Features, how-to, and troubleshooting for end users

## Key Features

- Expense splitting with equal, exact, percentage, and shares modes
- Debt simplification (minimum transactions to settle up)
- Direct device-to-device sync via WebRTC (no server)
- QR code connection setup (no public URL needed)
- Works offline: all data stored locally in IndexedDB
- Installable as a PWA on mobile and desktop
- Multi-currency support
- Spending statistics and "most spent with" insights

## Tech Stack

React 19 · TypeScript · Tailwind CSS 4 · Zustand · WebRTC · IndexedDB · Vite 8
