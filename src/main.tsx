import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { Capacitor } from '@capacitor/core'
import { SplashScreen } from '@capacitor/splash-screen'
import { StatusBar, Style } from '@capacitor/status-bar'
import { installTestBridge } from '@/lib/p2p/test-bridge'

// Enabled only when the URL carries `?e2eHook=1`; no-op otherwise.
installTestBridge()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if (Capacitor.isNativePlatform()) {
  // Keep the header below the status bar on WebViews with unreliable safe-area data.
  StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {})
  StatusBar.setStyle({ style: Style.Light })
  StatusBar.setBackgroundColor({ color: '#22c55e' })
  SplashScreen.hide()
}

// React error boundaries can't catch errors thrown in event handlers or in
// rejected promises (e.g. a camera restart race in the QR scanner). Without this,
// those show up as a silently blank screen with no way to recover except force-quit.
window.addEventListener('error', (e) => {
  console.error('[FairShare] Unhandled error:', e.error || e.message)
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('[FairShare] Unhandled promise rejection:', e.reason)
})

// a tab left open across a deploy asks for a lazy chunk the new worker already deleted
window.addEventListener('vite:preloadError', () => {
  window.location.reload()
})

if ('serviceWorker' in navigator && !Capacitor.isNativePlatform()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
  })
}
