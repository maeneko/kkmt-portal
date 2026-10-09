import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import './App.css';
import { api, ApiError, cached, clearCache, getNet, subscribeNet, isAdmin, isModerator, type Focus, type Me, type OpenLesson } from './lib/api';
import { IcoMoon, IcoShield, IcoSun } from './components/icons';
import Logo from './components/Logo';
import BottomNav from './components/BottomNav';
import TabMenu from './components/TabMenu';
import Login from './components/Login';
import LessonDetails from './tabs/schedule/LessonDetails';
import { TABS } from './tabs';

const THEME_KEY = 'kkmt.theme';
const ADMIN_KEY = 'kkmt.adminMode';

// Оболочка: сессия, тема, шапка (капсула + выпадающий список вкладок) и переключение вкладок из реестра TABS.
export default function App() {
    // прошлый ответ /me из кеша: интерфейс рисуется сразу, не дожидаясь сети
    const [me, setMe] = useState<Me | null>(() => cached<Me>('/me') ?? null);
    const [ready, setReady] = useState(!!me);
    const [group, setGroup] = useState(() => cached<{ groupName: string }>('/config')?.groupName ?? 'KKMT');
    const [activeTab, setActiveTab] = useState(TABS[0].id);
    const [focus, setFocus] = useState<Focus | null>(null);
    const goTo = useCallback((id: string, f?: Focus) => { setFocus(f ?? null); setActiveTab(id); window.scrollTo(0, 0); }, []);
    // открытая пара: подробности рисует App (над любой страницей), но при смене вкладки они закрываются
    const [lesson, setLesson] = useState<OpenLesson | null>(null);
    const [lessonRev, setLessonRev] = useState(0);
    // закрытие плавное: сначала панель уезжает (closing), через 260 мс её убираем совсем
    const [lessonClosing, setLessonClosing] = useState(false);
    const closeTimer = useRef<number>();
    const openLesson = useCallback((l: OpenLesson) => { window.clearTimeout(closeTimer.current); setLessonClosing(false); setLesson(l); }, []);
    const closeLesson = useCallback(() => {
        setLessonClosing(true);
        window.clearTimeout(closeTimer.current);
        closeTimer.current = window.setTimeout(() => { setLesson(null); setLessonClosing(false); }, 260);
    }, []);
    const [scrolled, setScrolled] = useState(false);
    // связь плохая — в шапке метка «данные могут быть устаревшими»; без связи по нажатию страница загружается заново
    const net = useSyncExternalStore(subscribeNet, getNet);
    const [retry, setRetry] = useState(0);
    const [msg, setMsg] = useState('');
    const [theme, setTheme] = useState<'light' | 'dark'>(() => {
        try { return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
    });
    // Режим админа (у модераторов и выше): выключенный прячет все кнопки правки, интерфейс как у студента
    const [adminMode, setAdminMode] = useState(() => {
        try { return localStorage.getItem(ADMIN_KEY) !== 'off'; } catch { return true; }
    });
    const toggleAdminMode = () => setAdminMode(on => {
        try { localStorage.setItem(ADMIN_KEY, on ? 'off' : 'on'); } catch { /* не критично */ }
        return !on;
    });
    const msgTimer = useRef<number>();

    const showMsg = useCallback((text: string) => {
        setMsg(text);
        window.clearTimeout(msgTimer.current);
        msgTimer.current = window.setTimeout(() => setMsg(''), 3000);
    }, []);

    const reloadMe = useCallback(async () => {
        // без сети остаёмся на данных из кеша; выходим, только если сервер ответил отказом (сессия истекла)
        try { setMe(await api<Me>('GET', '/me')); } catch (e) { if (e instanceof ApiError) { setMe(null); clearCache(); } }
    }, []);

    useEffect(() => { reloadMe().finally(() => setReady(true)); }, [reloadMe]);
    useEffect(() => { api<{ groupName: string }>('GET', '/config').then(c => setGroup(c.groupName)).catch(() => {}); }, []);

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
        try { localStorage.setItem(THEME_KEY, theme); } catch { /* не критично */ }
    }, [theme]);

    useEffect(() => { document.title = group; }, [group]);

    useEffect(() => {
        if (!lesson) return;
        const key = (e: KeyboardEvent) => { if (e.key === 'Escape') closeLesson(); };
        document.addEventListener('keydown', key);
        return () => document.removeEventListener('keydown', key);
    }, [lesson, closeLesson]);

    useEffect(() => {
        const h = () => setScrolled(window.scrollY > 4);
        window.addEventListener('scroll', h, { passive: true });
        return () => window.removeEventListener('scroll', h);
    }, []);

    const logout = async () => {
        try { await api('POST', '/auth/logout'); } catch { /* сессия уже могла истечь */ }
        clearCache(); setMe(null); setLesson(null); setActiveTab(TABS[0].id);
    };

    // вкладки и страницы видят пользователя с учётом режима админа; сервер проверяет права по настоящей роли
    const view = me && !adminMode ? { ...me, role: 'student' as const } : me;
    const tabs = TABS.filter(t => !t.adminOnly || (view && isAdmin(view)));
    const tab = tabs.find(t => t.id === activeTab) ?? tabs[0];
    // Заголовок «прокручивается» при смене вкладки: старый уезжает, новый въезжает;
    // вкладка правее — снизу вверх, левее — сверху вниз
    useEffect(() => { closeLesson(); }, [tab.id, closeLesson]);
    const lastTab = useRef(tab);
    const titleFrom = useRef<{ label: string; dir: number } | null>(null);
    if (lastTab.current.id !== tab.id) {
        const was = tabs.findIndex(t => t.id === lastTab.current.id);
        titleFrom.current = { label: lastTab.current.label, dir: tabs.indexOf(tab) >= was ? 1 : -1 };
        lastTab.current = tab;
    }

    return (
        <div className="app">
            {!me && (
                <button className="theme-toggle" aria-label={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
                        onClick={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}>
                    {theme === 'dark' ? <IcoSun /> : <IcoMoon />}
                </button>
            )}

            {!ready ? null : !me ? (
                <Login onDone={reloadMe} onConfig={c => setGroup(c.groupName)} />
            ) : (
                <>
                    <header className={`app-header${scrolled ? ' app-header--scrolled' : ''}`}>
                        <button className="brand-capsule" title="В ленту" onClick={() => goTo('feed')}>
                            <Logo size={28} />
                            <span className="brand-text">
                                <span className="brand-name">{group}</span>
                                <span className="brand-sub">Портал группы</span>
                            </span>
                        </button>
                        <div className="header-right">
                            {net !== 'ok' && (
                                <button className={`net-chip${net === 'offline' ? ' net-chip--off' : ''}`} aria-live="polite"
                                        title={net === 'offline' ? 'Нет связи с сервером: показаны сохранённые данные, они могут быть устаревшими. Нажмите, чтобы повторить' : 'Медленная сеть: пока показаны сохранённые данные, они могут быть устаревшими'}
                                        onClick={() => { if (net === 'offline') { reloadMe(); setRetry(r => r + 1); } }}>
                                    <i className="net-dot" />{net === 'offline' ? 'Нет связи' : 'Обновление…'}
                                </button>
                            )}
                            {isModerator(me) && (
                                <button className="theme-toggle theme-toggle--inline" aria-pressed={adminMode} title="Режим админа" aria-label={adminMode ? 'Выключить режим админа' : 'Включить режим админа'}
                                        onClick={toggleAdminMode}>
                                    <IcoShield />
                                </button>
                            )}
                            <button className="theme-toggle theme-toggle--inline" aria-label={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
                                    onClick={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}>
                                {theme === 'dark' ? <IcoSun /> : <IcoMoon />}
                            </button>
                            <TabMenu tabs={tabs} active={tab} onNavigate={goTo} onLogout={logout} onOpen={closeLesson} />
                        </div>
                    </header>

                    <main className="main">
                        <h2 className="page-title" key={`title-${tab.id}`} style={{ '--dir': titleFrom.current?.dir ?? 1 } as React.CSSProperties}>
                            {titleFrom.current && <span className="pt-out" aria-hidden>{titleFrom.current.label}</span>}
                            <span className="pt-in">{tab.label}</span>
                        </h2>
                        <tab.Page key={`page-${tab.id}-${retry}`} me={view ?? me} reloadMe={reloadMe} showMsg={showMsg} logout={logout} goTo={goTo} focus={focus}
                                  openLesson={openLesson} closeLesson={closeLesson} lessonOpen={lessonClosing ? null : lesson} lessonRev={lessonRev} />
                    </main>

                    <BottomNav tabs={tabs} active={tab.id} onNavigate={goTo} />
                    {lesson && <LessonDetails sel={lesson} closing={lessonClosing} me={view ?? me} showMsg={showMsg} onClose={closeLesson} onChanged={() => setLessonRev(r => r + 1)} />}
                </>
            )}
            {msg && <div className="snackbar" role="status">{msg}</div>}
        </div>
    );
}
