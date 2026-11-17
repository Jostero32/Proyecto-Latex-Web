import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Un solo origen para el navegador: Vite reenvía /api y /collab (WebSocket) al server. Así la cookie de
// sesión es del mismo sitio y no hace falta CORS. En compose, API_PROXY_TARGET=http://server:3000.
const target = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000';
const proxy = {
  '/api': { target },
  '/collab': { target, ws: true },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy },
  preview: { proxy },
  // El chunk del editor (CodeMirror y Yjs) ronda los 520 kB; se baja solo al abrir un proyecto.
  build: { chunkSizeWarningLimit: 600 },
});
