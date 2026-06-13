import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND = process.env.BACKEND_URL || 'http://localhost:3015';

const proxy = {
  '/api': {
    target: BACKEND,
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3014,
    proxy,
  },
  preview: {
    host: '0.0.0.0',
    port: 3014,
    proxy,
  },
});
