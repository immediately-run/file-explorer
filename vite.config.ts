import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The read-only Spaces panel — a first-party immediately.run system app
// (UI_AS_APPS_SPEC Phase 03 pilot). It reads the user's app-scoped spaces via
// the SDK and lists them. https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
});
