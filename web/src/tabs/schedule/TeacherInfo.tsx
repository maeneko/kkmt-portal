import { useState } from 'react';
import { api, errText } from '../../lib/api';
import { IcoInfo, IcoMail, IcoPhone } from '../../components/icons';
import type { Teacher } from '.';

// Преподаватель в карточке пары: имя и квадратная кнопка «i», по нажатию — телефон и почта (кликабельные); модератор правит контакты там же.
export default function TeacherInfo({ name, contact, canEdit, onSaved, showMsg }: {
    name: string; contact?: Teacher; canEdit: boolean; onSaved: () => void; showMsg: (t: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<{ phone: string; email: string } | null>(null);
    const [busy, setBusy] = useState(false);

    const save = async () => {
        if (!draft) return;
        setBusy(true);
        try { await api('PUT', '/teachers', { name, ...draft }); setDraft(null); onSaved(); }
        catch (e) { showMsg(errText(e)); } finally { setBusy(false); }
    };

    // содержимое плитки «Преподаватель» целиком (подпись, имя, кнопка на всю высоту, контакты): плитка в index.tsx без своих отступов
    return (
        <>
            <div className="ti-head">
                <div className="ti-text"><span className="ti-label">Преподаватель</span><span className="ti-name">{name}</span></div>
                <button className="ti-btn" aria-expanded={open} aria-label="Контакты преподавателя" title="Контакты" onClick={() => setOpen(o => !o)}><IcoInfo /></button>
            </div>
            {open && (
                <div className="ti-body">
                    {draft ? (
                        <form className="hw-form" onSubmit={e => { e.preventDefault(); save(); }}>
                            <input className="field" type="tel" autoFocus maxLength={30} placeholder="Телефон" value={draft.phone} onChange={e => setDraft({ ...draft, phone: e.target.value })} />
                            <input className="field" type="email" maxLength={100} placeholder="Почта" value={draft.email} onChange={e => setDraft({ ...draft, email: e.target.value })} />
                            <div className="row" style={{ justifyContent: 'flex-end' }}>
                                <button type="button" className="btn btn--tonal btn--sm" disabled={busy} onClick={() => setDraft(null)}>Отмена</button>
                                <button className="btn btn--primary btn--sm" disabled={busy}>Сохранить</button>
                            </div>
                        </form>
                    ) : (
                        <>
                            {contact?.phone || contact?.email ? (
                                <div className="hw-contact">
                                    {contact.phone && <a className="hw-contact-row" href={`tel:${contact.phone.replace(/[^\d+]/g, '')}`}><IcoPhone /><span>{contact.phone}</span></a>}
                                    {contact.email && <a className="hw-contact-row" href={`mailto:${contact.email}`}><IcoMail /><span>{contact.email}</span></a>}
                                </div>
                            ) : <span className="hint">Контакты не указаны</span>}
                            {canEdit && <button className="btn btn--tonal btn--sm" style={{ alignSelf: 'flex-start' }} onClick={() => setDraft({ phone: contact?.phone ?? '', email: contact?.email ?? '' })}>Изменить</button>}
                        </>
                    )}
                </div>
            )}
        </>
    );
}
