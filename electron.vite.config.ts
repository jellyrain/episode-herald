import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
      rolldownOptions: {
        external: ['openhongguo', 'node:sqlite'],
        output: { format: 'es', entryFileNames: 'index.mjs' }
      }
    }
  },
  preload: {
    build: {
      externalizeDeps: false,
      rolldownOptions: { output: { format: 'cjs', entryFileNames: 'index.js' } }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    server: { host: '127.0.0.1' },
    plugins: [
      react(),
      {
        name: 'hongguo-development-csp',
        apply: 'serve',
        transformIndexHtml: {
          order: 'post',
          handler(html) {
            // Authorize only Vite's exact refresh preamble without allowing arbitrary
            // inline scripts or eval in the renderer.
            const hashes = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
              .filter((match) => !/\bsrc\s*=/i.test(match[1]) && match[2].trim())
              .map((match) => `'sha256-${createHash('sha256').update(match[2]).digest('base64')}'`)
            return html
              .replace("script-src 'self';", `script-src 'self' ${hashes.join(' ')};`)
              .replace("connect-src 'self';", "connect-src 'self' ws://127.0.0.1:* ws://localhost:*;")
          }
        }
      }
    ]
  }
})
