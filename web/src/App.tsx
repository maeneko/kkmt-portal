import { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';
import { api, isAdmin, type Me } from './lib/api';
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
                        <div className="brand-capsule">
                            <Logo size={28} />
                            <div className="brand-text">
                                <span className="brand-name">{group}</span>
                                <span className="brand-sub">Портал группы</span>
                            </div>
                        </div>
                        <div className="header-right">
                            <button className="theme-toggle theme-toggle--inline" aria-label={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
                                    onClick={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}>
                                {theme === 'dark' ? <IcoSun /> : <IcoMoon />}
                            </button>
                            <TabMenu tabs={tabs} active={tab} onNavigate={setActiveTab} onLogout={logout} />
                        </div>
                    </header>

                    <main className="main">
                        <h2 className="page-title" key={`title-${tab.id}`}>{tab.label}</h2>
                        <tab.Page key={`page-${tab.id}`} me={me} reloadMe={reloadMe} showMsg={showMsg} logout={logout} />
                    </main>

                    <BottomNav tabs={tabs} active={tab.id} onNavigate={setActiveTab} />
                </>
            )}
            {msg && <div className="snackbar" role="status">{msg}</div>}
        </div>
    );
}
