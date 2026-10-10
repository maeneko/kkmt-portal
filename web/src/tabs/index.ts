// Автообнаружение вкладок: tabs/<name>/{index.tsx, metadata.json}
//   metadata.json — { id, label, icon, order?, adminOnly?, account? }
//   account — вкладка в шторке профиля (капсула справа вверху), а не в навигации
// Добавить вкладку = создать папку; этот файл трогать не нужно.
import type { Page } from '../lib/api';
import { ICONS } from '../components/icons';

export interface TabMeta { id: string; label: string; icon: string; order?: number; adminOnly?: boolean; account?: boolean }
export interface TabDef extends TabMeta { Icon: () => JSX.Element; Page: Page }

const metas = import.meta.glob<{ default: unknown }>('./*/metadata.json', { eager: true });
const pages = import.meta.glob<{ default: Page }>('./*/index.tsx', { eager: true });
const folderOf = (path: string) => path.split('/')[1];

function toMeta(name: string, raw: unknown): TabMeta {
    const m = (raw ?? {}) as Record<string, unknown>;
    const str = (key: string): string => {
        const v = m[key];
        if (typeof v !== 'string' || v.trim() === '') throw new Error(`tabs/${name}/metadata.json: поле "${key}" должно быть непустой строкой`);
        return v;
    };
    if (m.order !== undefined && typeof m.order !== 'number') throw new Error(`tabs/${name}/metadata.json: "order" должно быть числом`);
    return { id: str('id'), label: str('label'), icon: str('icon'), order: m.order as number | undefined, adminOnly: m.adminOnly === true, account: m.account === true };
}

export const TABS: TabDef[] = Object.entries(metas)
    .map(([path, mod]) => {
        const name = folderOf(path);
        const meta = toMeta(name, mod.default);
        const page = pages[`./${name}/index.tsx`]?.default;
        if (!page) throw new Error(`tabs/${name}: нет index.tsx рядом с metadata.json`);
        if (!ICONS[meta.icon]) throw new Error(`tabs/${name}: иконка "${meta.icon}" не зарегистрирована в ICONS`);
        return { ...meta, Icon: ICONS[meta.icon], Page: page };
    })
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
