// Знак приложения: скруглённый квадрат цвета primary с шапочкой выпускника.
export default function Logo({ size = 32, className = '' }: { size?: number; className?: string }) {
    return (
        <span className={`logo ${className}`} style={{ width: size, height: size, borderRadius: size >= 48 ? 14 : 9 }} aria-hidden>
            <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="m2 9 10-5 10 5-10 5z" /><path d="M6 11.5V16c0 1.2 2.7 3 6 3s6-1.8 6-3v-4.5" /><path d="M22 9v6" />
            </svg>
        </span>
    );
}
