import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/orthanc': {
        target: 'http://127.0.0.1:8043',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/orthanc/, ''),
        configure(proxy) {
          proxy.on('error', (err, req) => {
            console.error('[vite-proxy] error', req?.url, err?.message);
          });
          proxy.on('proxyReq', (proxyReq, req) => {
            console.info('[vite-proxy] forward', req.url, '->', proxyReq.getHeader('host'));
          });
        },
      },
    },
  },
})
