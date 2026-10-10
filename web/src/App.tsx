import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import './App.css';
import { api, ApiError, cached, clearCache, getNet, subscribeNet, isAdmin, isModerator, type Focus, type Me, type OpenLesson } from './lib/api';
import { IcoMenu, IcoMoon, IcoSun } from './components/icons';
import Logo from './components/Logo';
import BottomNav from './components/BottomNav';
import NavDrawer from './components/NavDrawer';
import ProfileMenu from './components/ProfileMenu';
import Login from './components/Login';
import LessonDetails from './tabs/schedule/LessonDetails';
import { TABS } from './tabs';

const THEME_KEY = 'kkmt.theme';
const ADMIN_KEY = 'kkmt.adminMode';
const NAV_KEY = 'kkmt.navOpen';

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
    // только панель справа на ПК: на телефоне подробности — шторка, а навигации там нет
    const panelShown = !!lesson && !lessonClosing && lesson.pop;
    useEffect(() => { setNavShrunk(panelShown); }, [panelShown]);
    // Навигация на ПК: navOpen — выбор человека («три полоски», запоминается; пока не выбирали — развёрнута на широком окне).
    // navShrunk — временное сворачивание, пока открыты подробности пары: освобождает место, а при закрытии всё возвращается как было.
    const [navOpen, setNavOpen] = useState(() => {
        try { const v = localStorage.getItem(NAV_KEY); if (v) return v === 'on'; } catch { /* нет хранилища */ }
        return window.innerWidth >= 1200;
    });
    const [navShrunk, setNavShrunk] = useState(false);
    const navExpanded = navOpen && !navShrunk;
    const saveNav = (open: boolean) => { setNavOpen(open); try { localStorage.setItem(NAV_KEY, open ? 'on' : 'off'); } catch { /* не критично */ } };
    // «Три полоски» сильнее автоматики: развернули при открытых подробностях — остаётся развёрнутой до закрытия и после
    const toggleNav = () => {
        if (navExpanded) return saveNav(false);
        setNavShrunk(false);
        saveNav(true);
    };
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
    // профиль и админка — в шторке профиля, в навигации только разделы
    const navTabs = tabs.filter(t => !t.account);
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
        <div className={`app${navExpanded ? ' app--nav-open' : ''}`}>
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
                    <NavDrawer tabs={navTabs} active={tab.id} onNavigate={goTo} />
                    <header className={`app-header${scrolled ? ' app-header--scrolled' : ''}`}>
                        <div className="header-left">
                            <button className="btn-icon btn-icon--neutral nav-toggle" aria-expanded={navExpanded} aria-label={navExpanded ? 'Свернуть навигацию' : 'Развернуть навигацию'} title={navExpanded ? 'Свернуть' : 'Развернуть'} onClick={toggleNav}>
                                <IcoMenu />
                            </button>
                            <button className="brand-capsule" title="В ленту" onClick={() => goTo('feed')}>
                                <Logo size={28} />
                                <span className="brand-text">
                                    <span className="brand-name">{group}</span>
                                    <span className="brand-sub">Портал группы</span>
                                </span>
                            </button>
                            {/* сюда страница ставит свою кнопку на месте капсулы (на телефоне — «три полоски» каналов ленты); капсула плавно сжимается */}
                            <span className="title-slot" id="title-slot" />
                        </div>
                        <div className="header-right">
                            {net !== 'ok' && (
                                <button className={`net-chip${net === 'offline' ? ' net-chip--off' : ''}`} aria-live="polite"
                                        title={net === 'offline' ? 'Нет связи с сервером: показаны сохранённые данные, они могут быть устаревшими. Нажмите, чтобы повторить' : 'Медленная сеть: пока показаны сохранённые данные, они могут быть устаревшими'}
                                        onClick={() => { if (net === 'offline') { reloadMe(); setRetry(r => r + 1); } }}>
                                    <i className="net-dot" />{net === 'offline' ? 'Нет связи' : 'Обновление…'}
                                </button>
                            )}
                            <ProfileMenu me={me} tabs={tabs.filter(t => t.account)} active={tab.id} onNavigate={goTo}
                                         dark={theme === 'dark'} onDark={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}
                                         adminMode={adminMode} onAdminMode={isModerator(me) ? toggleAdminMode : undefined} onLogout={logout} onOpen={closeLesson}
                                         reloadMe={reloadMe} showMsg={showMsg} />
                        </div>
                    </header>

                    <main className="main">
                        <h2 className="page-title" key={`title-${tab.id}`} style={{ '--dir': titleFrom.current?.dir ?? 1 } as React.CSSProperties}>
                            {titleFrom.current && <span className="pt-out" aria-hidden>{titleFrom.current.label}</span>}
                            <span className="pt-in">{tab.label}</span>
                        </h2>
                        <tab.Page key={`page-${tab.id}-${retry}`} group={group} me={view ?? me} reloadMe={reloadMe} showMsg={showMsg} logout={logout} goTo={goTo} focus={focus}
                                  openLesson={openLesson} closeLesson={closeLesson} lessonOpen={lessonClosing ? null : lesson} lessonRev={lessonRev} />
                    </main>

                    <BottomNav tabs={navTabs} active={tab.id} onNavigate={goTo} />
                    {lesson && <LessonDetails sel={lesson} closing={lessonClosing} me={view ?? me} showMsg={showMsg} onClose={closeLesson} onChanged={() => setLessonRev(r => r + 1)} />}
                </>
            )}
            {msg && <div className="snackbar" role="status">{msg}</div>}
        </div>
    );
}
