import type { ComponentType } from 'react';

export type Role = 'student' | 'moderator' | 'admin' | 'owner';

export interface Me {
    id: number;
    username: string | null;
    first_name: string;
    last_name: string | null;
    photo_url: string | null;
    display_name: string | null;
    real_name?: string | null; // фамилия и имя; приходит только модераторам и выше (и своё)
    bio: string;
    role: Role;
}

export interface PageProps {
    me: Me;
    group: string; // название группы (для капсулы в шторке каналов ленты)
    reloadMe: () => Promise<void>;
    showMsg: (text: string) => void;
    logout: () => void;
    // переход на другую вкладку; для расписания — с фокусом на дату и пару
    goTo: (tab: string, focus?: Focus) => void;
    focus: Focus | null;
    // подробности пары рисует App; при смене вкладки они закрываются
    openLesson: (l: OpenLesson) => void;
    closeLesson: () => void;
    // какая пара сейчас открыта и сколько раз что-то менялось в её материалах (чтобы расписание обновило значки)
    lessonOpen: { date: string; pair_no: number } | null;
    lessonRev: number;
}
export interface Focus { date: string; pair: number }
// Пара, открытая в подробностях: что показать и в каком виде (pop — панель справа на ПК, иначе шторка на телефоне)
export interface OpenLesson { subject: string; teacher: string; room: string; pair_no: number; weekday: number; day: string; date: string; pop: boolean }
export type Page = ComponentType<PageProps>;

export class ApiError extends Error {
    constructor(public status: number, message: string, public data: Record<string, unknown> = {}) { super(message); }
}

// Связь для метки в шапке: slow — данные грузятся дольше 1,5 с, offline — последняя загрузка не дошла.
// В обоих случаях на экране могут быть сохранённые (устаревшие) данные.
export type Net = 'ok' | 'slow' | 'offline';
let net: Net = 'ok', slowCount = 0, offline = false;
const netSubs = new Set<() => void>();
function updateNet() {
    const n: Net = offline ? 'offline' : slowCount > 0 ? 'slow' : 'ok';
    if (n !== net) { net = n; netSubs.forEach(f => f()); }
}
export const getNet = () => net;
export const subscribeNet = (f: () => void) => { netSubs.add(f); return () => { netSubs.delete(f); }; };

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
    const get = method === 'GET';
    let late = false;
    const timer = get ? window.setTimeout(() => { late = true; slowCount++; updateNet(); }, 1500) : 0;
    let res: Response;
    try {
        res = await fetch(`/api${url}`, {
            method,
            credentials: 'same-origin',
            headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (get) offline = false;
    } catch (e) {
        if (get) offline = true;
        throw e;
    } finally {
        window.clearTimeout(timer);
        if (late) slowCount--;
        updateNet();
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Ошибка ${res.status}`, data);
    if (method === 'GET') remember(url, data);
    return data as T;
}

// Последние ответы GET (до 30 адресов, в localStorage): страница сразу рисует прошлые данные,
// а свежие подставляет, когда придут, — на медленном интернете не смотрим на пустой экран.
const CACHE_KEY = 'kkmt.cache';
let cache: Record<string, unknown> = {};
try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}'); } catch { /* нет кеша */ }

function remember(url: string, data: unknown) {
    delete cache[url];
    cache[url] = data; // свежий — в конец, самые старые удаляются
    const keys = Object.keys(cache);
    for (const k of keys.slice(0, keys.length - 30)) delete cache[k];
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* не критично */ }
}
export const cached = <T,>(url: string) => cache[url] as T | undefined;
export function clearCache() {
    cache = {};
    try { localStorage.removeItem(CACHE_KEY); } catch { /* не критично */ }
}

export const ROLE_LABEL: Record<Role, string> = { owner: 'Главный админ', admin: 'Админ', moderator: 'Модератор', student: 'Студент' };
export const isAdmin = (m: Me) => m.role === 'admin' || m.role === 'owner';
export const isModerator = (m: Me) => m.role !== 'student';
// Ник/имя на экране не длиннее 32 символов: остальное заменяется на «...» (считаем символы Unicode, эмодзи не рвётся)
export const NICK_MAX = 32;
export const clip = (s: string, max = NICK_MAX) => {
    const chars = Array.from(s);
    return chars.length > max ? `${chars.slice(0, max - 3).join('')}...` : s;
};
export const displayName = (u: { display_name: string | null; first_name: string; last_name?: string | null; username?: string | null }) =>
    clip(u.display_name || [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'Без имени');

export const errText = (e: unknown) => (e instanceof Error ? e.message : 'Ошибка');
