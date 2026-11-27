import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Un solo origen para el navegador: Vite reenvía /api y /collab (WebSocket) al server. Así la cookie de
// sesión es del mismo sitio y no hace falta CORS. En compose, API_PROXY_TARGET=http://server:3000.
const target = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:53000';
const proxy = {
  '/api': { target },
  '/collab': { target, ws: true },
};

const allowedHosts = process.env.ALLOWED_HOSTS?.split(',').map((host) => host.trim()).filter(Boolean)
  ?? ['127.0.0.1', 'localhost', '[::1]'];

function contentSecurityPolicy(nonce?: string): string {
  return [
    "default-src 'none'", "script-src 'self'",
    `style-src 'self'${nonce ? ` 'nonce-${nonce}'` : ''}`,
    "font-src 'self'", "img-src 'self' data: blob:", "connect-src 'self'",
    "worker-src 'self'", "frame-ancestors 'none'", "base-uri 'none'",
    "form-action 'self'", "object-src 'none'",
  ].join('; ');
}

// Preview es lo que sirve el contenedor. HMR de desarrollo necesita otra política.
const headers = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': contentSecurityPolicy(),
};

function securePreview(): Plugin {
  return {
    name: 'secure-preview-html',
    configurePreviewServer(server) {
      const html = readFileSync(resolve(server.config.root, server.config.build.outDir, 'index.html'), 'utf8');
      server.middlewares.use((request, response, next) => {
        let path: string;
        try { path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname); }
        catch {
          response.writeHead(400, { ...headers, 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Content-Type': 'text/plain; charset=utf-8' });
          return response.end('Petición inválida');
        }
        if (!['GET', 'HEAD'].includes(request.method ?? '') || path === '/api' || path.startsWith('/api/')
          || path.startsWith('/collab')) return next();
        // Este middleware precede al de Vite: también debe validar Host contra DNS rebinding.
        let host = '';
        const rawHost = request.headers.host ?? '';
        if (/^(?:\[[\da-f:]+\]|[\da-z.-]+)(?::\d{1,5})?$/i.test(rawHost)) {
          try { host = new URL(`http://${rawHost}`).hostname; } catch { /* Host inválido. */ }
        }
        if (!allowedHosts.includes(host)) {
          response.writeHead(403, { ...headers, 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Content-Type': 'text/plain; charset=utf-8' });
          return response.end('Host no permitido');
        }
        // Un recurso inexistente no debe convertirse en HTML mediante el fallback de la SPA.
        if (path === '/robots.txt' || path === '/sitemap.xml') {
          const body = path === '/robots.txt'
            ? 'User-agent: *\nDisallow: /\n'
            : 'Recurso no encontrado\n';
          response.writeHead(path === '/robots.txt' ? 200 : 404, {
            ...headers, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate',
          });
          return response.end(request.method === 'HEAD' ? undefined : body);
        }
        if (path !== '/index.html' && path.split('/').pop()?.includes('.')) {
          response.setHeader('Cache-Control', /^\/assets\/[^/]+-[\w-]{8,}\.[\w.]+$/.test(path)
            ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
          return next();
        }
        const nonce = randomBytes(24).toString('base64');
        const page = html.replace('<head>', `<head><meta name="csp-nonce" content="${nonce}">`);
        response.writeHead(200, {
          ...headers, 'Content-Security-Policy': contentSecurityPolicy(nonce),
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(page),
        });
        response.end(request.method === 'HEAD' ? undefined : page);
      });
      // Después del servidor de archivos de Vite: sus 404 también reciben la CSP completa.
      return () => {
        server.middlewares.use((request, response) => {
          response.writeHead(404, {
            ...headers, 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Content-Type': 'text/plain; charset=utf-8',
          });
          response.end(request.method === 'HEAD' ? undefined : 'Recurso no encontrado\n');
        });
      };
    },
  };
}

export default defineConfig(({ isPreview }) => ({
  plugins: [react(), tailwindcss(), securePreview()],
  // Puertos poco comunes para no chocar con otros proyectos (en compose, el contenedor publica 55173).
  server: { port: 55173, strictPort: true, proxy },
  preview: {
    port: 55173, strictPort: true, proxy, headers, allowedHosts,
  },
  // El chunk del editor (CodeMirror y Yjs) ronda los 520 kB; se baja solo al abrir un proyecto.
  // Los recursos inexistentes deben ser 404, sin un segundo fallback HTML de Vite.
  appType: isPreview ? 'custom' : 'spa',
  build: { chunkSizeWarningLimit: 600 },
}));
