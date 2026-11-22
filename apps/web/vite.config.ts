/// <reference types="vitest/config" />
import path from 'path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { playwright } from '@vitest/browser-playwright'
import { readFileSync } from 'node:fs'
import { localMediaProxy } from './config/local-media-proxy'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxyTarget = env.VITE_CORE_API_PROXY_TARGET
  const httpsKeyFile = env.WEB_DEV_HTTPS_KEY_FILE
  const httpsCertFile = env.WEB_DEV_HTTPS_CERT_FILE

  if ((httpsKeyFile && !httpsCertFile) || (!httpsKeyFile && httpsCertFile)) {
    throw new Error(
      'WEB_DEV_HTTPS_KEY_FILE and WEB_DEV_HTTPS_CERT_FILE must be configured together'
    )
  }

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
      ...(httpsKeyFile && httpsCertFile
        ? {
            https: {
              key: readFileSync(httpsKeyFile),
              cert: readFileSync(httpsCertFile),
            },
          }
        : {}),
      proxy: {
        ...(proxyTarget && {
          '/api': { target: proxyTarget, changeOrigin: false },
        }),
      },
    },
    test: {
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
