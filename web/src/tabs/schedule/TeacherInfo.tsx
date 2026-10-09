import { useState } from 'react';
import { api, errText } from '../../lib/api';
import type { Teacher } from '.';

// Преподаватель в карточке пары: имя, телефон и почта (кликабельные); модератор правит контакты на месте.
export default function TeacherInfo({ name, contact, canEdit, onSaved, showMsg }: {
    name: string; contact?: Teacher; canEdit: boolean; onSaved: () => void; showMsg: (t: string) => void;
}) {
    const [draft, setDraft] = useState<{ phone: string; email: string } | null>(null);
    const [busy, setBusy] = useState(false);

    const save = async () => {
        if (!draft) return;
        setBusy(true);
        try { await api('PUT', '/teachers', { name, ...draft }); setDraft(null); onSaved(); }
        catch (e) { showMsg(errText(e)); } finally { setBusy(false); }
    };

    return (
        <div className="stack" style={{ gap: 6 }}>
            <span>{name}</span>
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
                    {(contact?.phone || contact?.email) && (
                        <div className="hw-contact">
                            {contact.phone && <a href={`tel:${contact.phone.replace(/[^\d+]/g, '')}`}>{contact.phone}</a>}
                            {contact.email && <a href={`mailto:${contact.email}`}>{contact.email}</a>}
                        </div>
                    )}
                    {canEdit && <button className="btn btn--tonal btn--sm" style={{ alignSelf: 'flex-start' }} onClick={() => setDraft({ phone: contact?.phone ?? '', email: contact?.email ?? '' })}>Контакты</button>}
                </>
            )}
        </div>
    );
}
