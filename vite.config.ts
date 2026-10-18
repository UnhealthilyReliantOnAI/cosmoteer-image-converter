import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// GitHub Pages project path, matching the repository name.
// A one-off build can also use: npm.cmd run build -- --base /another-name/
const publicBase = '/cosmoteer-image-converter/';

export default defineConfig({
  base: publicBase,
  plugins: [react()],
  build: { sourcemap: false },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});
