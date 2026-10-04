import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'

// hash built assets so the service worker gets a fresh cache name per deploy
function swCacheVersionPlugin() {
  return {
    name: 'sw-cache-version',
    closeBundle() {
      const distDir = path.resolve(__dirname, 'dist')
      const swPath = path.join(distDir, 'sw.js')
      if (!fs.existsSync(swPath)) return

      const assetsDir = path.join(distDir, 'assets')
      const assetNames = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).sort() : []
      const hash = crypto.createHash('md5')
      for (const name of assetNames) hash.update(name)
      const buildHash = hash.digest('hex').slice(0, 10)

      let swContent = fs.readFileSync(swPath, 'utf-8')
      const updated = swContent.replace(
        /const CACHE_NAME = ['"][^'"]*['"];/,
        `const CACHE_NAME = 'fairshare-${buildHash}';`
      )
      // do not deploy if the cache placeholder was not replaced
      if (updated === swContent) {
        throw new Error('sw.js CACHE_NAME placeholder not found — swCacheVersionPlugin needs updating')
      }
      swContent = updated

      // precache the actual hashed asset filenames so a first-ever offline
      // load doesn't rely on the opportunistic runtime fetch cache having anything in it yet.
      const builtAssetsList = assetNames.map((name) => `'/assets/${name}'`).join(', ')
      const withAssets = swContent.replace(
        /const BUILT_ASSETS = \[\];/,
        `const BUILT_ASSETS = [${builtAssetsList}];`
      )
      if (withAssets === swContent) {
        throw new Error('sw.js BUILT_ASSETS placeholder not found — swCacheVersionPlugin needs updating')
      }
      fs.writeFileSync(swPath, withAssets)
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), swCacheVersionPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // '' made nested routes load /group/assets/... on reload. Capacitor serves from its origin root, so '/' works there too.
  base: '/',
  server: {
    watch: {
      // Prevent Vite from watching native project folders and APK files (causes EBUSY on Windows)
      ignored: ['**/android/**', '**/ios/**', '**/*.apk'],
    },
  },
})
