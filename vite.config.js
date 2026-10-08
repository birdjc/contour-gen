import { defineConfig } from 'vite';

// base './' keeps built asset paths relative, so dist/ works from a GitHub Pages project subpath.
export default defineConfig({
  base: './',
  server: { port: 5174, strictPort: true },
  worker: { format: 'es' }
});
