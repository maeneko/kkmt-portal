import type { ComponentType } from 'react';

export type Role = 'student' | 'admin' | 'owner';

export interface Me {
    id: number;
    username: string | null;
    first_name: string;
    last_name: string | null;
    photo_url: string | null;
    display_name: string | null;
    bio: string;
    role: Role;
}

export interface PageProps {
    me: Me;
    reloadMe: () => Promise<void>;
    showMsg: (text: string) => void;
    logout: () => void;
}
export type Page = ComponentType<PageProps>;

export class ApiError extends Error {
    constructor(public status: number, message: string, public data: Record<string, unknown> = {}) { super(message); }
}

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(`/api${url}`, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Ошибка ${res.status}`, data);
    return data as T;
}

export const isAdmin = (m: Me) => m.role !== 'student';
// Ник/имя на экране не длиннее 32 символов: остальное заменяется на «...» (считаем символы Unicode, эмодзи не рвётся)
export const NICK_MAX = 32;
export const clip = (s: string, max = NICK_MAX) => {
    const chars = Array.from(s);
    return chars.length > max ? `${chars.slice(0, max - 3).join('')}...` : s;
};
export const displayName = (u: { display_name: string | null; first_name: string; last_name?: string | null; username?: string | null }) =>
    clip(u.display_name || [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'Без имени');

export const errText = (e: unknown) => (e instanceof Error ? e.message : 'Ошибка');
