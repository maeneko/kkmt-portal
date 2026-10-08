export default function Avatar({ name, photo, large }: { name: string; photo?: string | null; large?: boolean }) {
    const cls = `avatar${large ? ' avatar--lg' : ''}`;
    if (photo) return <img className={cls} src={photo} alt="" referrerPolicy="no-referrer" loading="lazy" decoding="async" />;
    return <span className={cls} aria-hidden>{name.trim().charAt(0).toUpperCase() || '?'}</span>;
}
