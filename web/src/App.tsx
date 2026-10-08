import { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';
import { api, isAdmin, type Focus, type Me } from './lib/api';
import { IcoMoon, IcoSun } from './components/icons';
import Logo from './components/Logo';
import BottomNav from './components/BottomNav';
import TabMenu from './components/TabMenu';
import Login from './components/Login';
import { TABS } from './tabs';

const THEME_KEY = 'kkmt.theme';

// Оболочка: сессия, тема, шапка (капсула + выпадающий список вкладок) и переключение вкладок из реестра TABS.
export default function App() {
    const [me, setMe] = useState<Me | null>(null);
    const [ready, setReady] = useState(false);
    const [group, setGroup] = useState('KKMT');
    const [activeTab, setActiveTab] = useState(TABS[0].id);
    const [focus, setFocus] = useState<Focus | null>(null);
    const goTo = useCallback((id: string, f?: Focus) => { setFocus(f ?? null); setActiveTab(id); window.scrollTo(0, 0); }, []);
    const [scrolled, setScrolled] = useState(false);
    const [msg, setMsg] = useState('');
    const [theme, setTheme] = useState<'light' | 'dark'>(() => {
        try { return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
    });
    const msgTimer = useRef<number>();

    const showMsg = useCallback((text: string) => {
        setMsg(text);
        window.clearTimeout(msgTimer.current);
        msgTimer.current = window.setTimeout(() => setMsg(''), 3000);
    }, []);

    const reloadMe = useCallback(async () => {
        try { setMe(await api<Me>('GET', '/me')); } catch { setMe(null); }
    }, []);

    useEffect(() => { reloadMe().finally(() => setReady(true)); }, [reloadMe]);
    useEffect(() => { api<{ groupName: string }>('GET', '/config').then(c => setGroup(c.groupName)).catch(() => {}); }, []);

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
        try { localStorage.setItem(THEME_KEY, theme); } catch { /* не критично */ }
    }, [theme]);

    useEffect(() => { document.title = group; }, [group]);

    useEffect(() => {
        const h = () => setScrolled(window.scrollY > 4);
        window.addEventListener('scroll', h, { passive: true });
        return () => window.removeEventListener('scroll', h);
    }, []);

    const logout = async () => {
        try { await api('POST', '/auth/logout'); } catch { /* сессия уже могла истечь */ }
        setMe(null); setActiveTab(TABS[0].id);
    };

    const tabs = TABS.filter(t => !t.adminOnly || (me && isAdmin(me)));
    const tab = tabs.find(t => t.id === activeTab) ?? tabs[0];
    // Заголовок «прокручивается» при смене вкладки: старый уезжает, новый въезжает;
    // вкладка правее — снизу вверх, левее — сверху вниз
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
                            <button className="theme-toggle theme-toggle--inline" aria-label={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
                                    onClick={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}>
                                {theme === 'dark' ? <IcoSun /> : <IcoMoon />}
                            </button>
                            <TabMenu tabs={tabs} active={tab} onNavigate={goTo} onLogout={logout} />
                        </div>
                    </header>

                    <main className="main">
                        <h2 className="page-title" key={`title-${tab.id}`} style={{ '--dir': titleFrom.current?.dir ?? 1 } as React.CSSProperties}>
                            {titleFrom.current && <span className="pt-out" aria-hidden>{titleFrom.current.label}</span>}
                            <span className="pt-in">{tab.label}</span>
                        </h2>
                        <tab.Page key={`page-${tab.id}`} me={me} reloadMe={reloadMe} showMsg={showMsg} logout={logout} goTo={goTo} focus={focus} />
                    </main>

                    <BottomNav tabs={tabs} active={tab.id} onNavigate={goTo} />
                </>
            )}
            {msg && <div className="snackbar" role="status">{msg}</div>}
        </div>
    );
}
