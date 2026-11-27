/// <reference types="vitest/config" />
import path from 'path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { playwright } from '@vitest/browser-playwright'
import { localMediaProxy } from './config/local-media-proxy'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxyTarget = env.VITE_CORE_API_PROXY_TARGET

  return {
    plugins: [
      tanstackRouter({
        target: 'react',
        autoCodeSplitting: true,
        routeFileIgnorePattern: 'auth-session\\.integration\\.test\\.tsx$',
      }),
      react(),
      tailwindcss(),
      ...(env.VITE_LOCAL_MEDIA_STORAGE_ORIGIN
        ? [
            localMediaProxy(
              env.VITE_LOCAL_MEDIA_STORAGE_ORIGIN,
              env.LOCAL_MEDIA_STORAGE_CA_FILE
            ),
          ]
        : []),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        ...(proxyTarget && {
          '/api': { target: proxyTarget, changeOrigin: false },
        }),
      },
    },
    // Browser tests mount React through react-dom/client. Prebundle it
    // before running tests to avoid an optimizer-triggered iframe reload.
    optimizeDeps: {
      include: ['react-dom/client'],
    },
    test: {
      setupFiles: ['./src/test-utils/browser-setup.ts'],
      silent: 'passed-only',
      unstubEnvs: true,
      passWithNoTests: false,
      ...(process.env.GITHUB_ACTIONS === 'true'
        ? {
            reporters: [
              'default',
              'github-actions',
              ['junit', { outputFile: 'test-results/vitest.junit.xml' }],
            ],
          }
        : {}),
      browser: {
        enabled: true,
        provider: playwright(),
        instances: [{ browser: 'chromium' }],
      },
      coverage: {
        // include: ['src/**/*.{js,jsx,ts,tsx}'], // Uncomment to expand the report to all src/**/* so untested modules appear as 0% coverage.
        exclude: [
          'src/components/ui/**',
          'src/assets/**',
          'src/tanstack-table.d.ts',
          'src/routeTree.gen.ts',
          'src/test-utils/**',
          'src/routes/**',
        ],
      },
    },
  }
})
