// Иконки интерфейса (inline SVG, currentColor). Добавляя вкладку — добавь сюда
// её иконку и зарегистрируй имя в ICONS (его указывают в tabs/<name>/metadata.json).
const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export const IcoMenu = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" {...S}><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
);
export const IcoFeed = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" {...S}><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>
);
export const IcoCalendar = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" {...S}><rect x="3" y="4" width="18" height="18" rx="3"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
);
export const IcoPerson = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" {...S}><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/></svg>
);
export const IcoShield = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" {...S}><path d="M12 3 4 6v6c0 5 3.4 8.4 8 9.5 4.6-1.1 8-4.5 8-9.5V6z"/><path d="m9 12 2 2 4-4"/></svg>
);
export const IcoPlus = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" {...S} strokeWidth={2.5}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
);
export const IcoHeart = ({ filled }: { filled?: boolean }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" {...S} fill={filled ? 'currentColor' : 'none'}><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/></svg>
);
export const IcoComment = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" {...S}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
);
export const IcoPin = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" {...S}><path d="M12 17v5"/><path d="M9 3h6l-1 7 3 3v2H7v-2l3-3z"/></svg>
);
export const IcoTrash = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" {...S}><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
);
export const IcoCopy = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" {...S}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
);
export const IcoLogout = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" {...S}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
);
export const IcoSun = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" {...S}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
);
export const IcoMoon = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" {...S}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
);

export const IcoChevron = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" {...S}><polyline points="6 9 12 15 18 9"/></svg>
);

export const IcoCheck = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" {...S} strokeWidth={2.5}><polyline points="4 12 10 18 20 6"/></svg>
);
export const IcoTelegram = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" {...S}><path d="M21.5 3.5 2.5 10.8l6.2 2.3 2.4 7.2 3.4-4.6 5 3.7z"/><path d="m8.7 13.1 9.3-6.6"/></svg>
);
export const IcoNote = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" {...S}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="14 3 14 9 20 9"/><line x1="8" y1="14" x2="16" y2="14"/><line x1="8" y1="18" x2="13" y2="18"/></svg>
);
export const IcoClip = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" {...S}><path d="m21 11-9 9a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8"/></svg>
);
export const IcoPhone = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" {...S}><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>
);
export const IcoMail = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" {...S}><rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="3 7 12 13 21 7"/></svg>
);
export const IcoInfo = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" {...S}><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
);
export const IcoDownload = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" {...S}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
);
export const IcoFolder = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" {...S}><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
);

export const IcoEdit = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" {...S}><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
);

export const IcoUndo = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" {...S}><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>
);

export const ICONS: Record<string, () => JSX.Element> = {
    feed: IcoFeed, calendar: IcoCalendar, person: IcoPerson, shield: IcoShield, folder: IcoFolder,
};
