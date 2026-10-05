import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    root: 'web',
    plugins: [react()],
    build: { outDir: '../dist/public', emptyOutDir: true },
    server: {
        port: 5173,
        proxy: { '/api': 'http://localhost:3000' },
        // Для проверки виджета Telegram через туннель (ngrok, cloudflared): ALLOWED_HOSTS=my-tunnel.ngrok-free.app
        allowedHosts: process.env.ALLOWED_HOSTS ? process.env.ALLOWED_HOSTS.split(',') : undefined,
    },
});
