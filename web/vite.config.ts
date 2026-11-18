import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Un solo origen para el navegador: Vite reenvía /api y /collab (WebSocket) al server. Así la cookie de
// sesión es del mismo sitio y no hace falta CORS. En compose, API_PROXY_TARGET=http://server:3000.
const target = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:53000';
const proxy = {
  '/api': { target },
  '/collab': { target, ws: true },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Puertos poco comunes para no chocar con otros proyectos (en compose, el contenedor publica 55173).
  server: { port: 55173, strictPort: true, proxy },
  preview: { port: 55173, strictPort: true, proxy },
  // El chunk del editor (CodeMirror y Yjs) ronda los 520 kB; se baja solo al abrir un proyecto.
  build: { chunkSizeWarningLimit: 600 },
});
