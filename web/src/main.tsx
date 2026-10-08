import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

// Кеш аватарок и файлов сайта (только в сборке: в разработке мешал бы горячей перезагрузке)
if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>
);
