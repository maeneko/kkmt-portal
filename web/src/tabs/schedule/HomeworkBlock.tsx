import { useRef, useState } from 'react';
import { api, errText } from '../../lib/api';
import { IcoClip, IcoDownload, IcoPlus, IcoTrash } from '../../components/icons';

export interface HwFile { id: number; name: string; size: number }
export interface HwItem { date: string; pair_no: number; body: string; files: HwFile[] }

const MAX_MB = 20;
const ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip,.jpg,.jpeg,.png';
const fmtSize = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(b / 1024))} КБ`);

// Домашнее задание и файлы к паре: читают все, добавляют и меняют админы/староста.
export default function HomeworkBlock({ date, pair, item, canEdit, onChanged, showMsg }: {
    date: string; pair: number; item?: HwItem; canEdit: boolean; onChanged: () => void; showMsg: (t: string) => void;
}) {
    const body = item?.body ?? '';
    const files = item?.files ?? [];
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const input = useRef<HTMLInputElement>(null);

    const save = async () => {
        setBusy(true);
        try { await api('PUT', '/homework', { date, pair_no: pair, body: draft }); setEditing(false); onChanged(); }
        catch (e) { showMsg(errText(e)); } finally { setBusy(false); }
    };

    const upload = async (list: FileList | null) => {
        if (!list?.length) return;
        setBusy(true);
        try {
            for (const f of Array.from(list)) {
                if (f.size > MAX_MB * 1048576) { showMsg(`«${f.name}» больше ${MAX_MB} МБ`); continue; }
                const res = await fetch(`/api/homework/files?date=${date}&pair_no=${pair}&name=${encodeURIComponent(f.name)}`, {
                    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: f,
                });
                if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error((d as { error?: string }).error ?? `Ошибка ${res.status}`); }
            }
            onChanged();
        } catch (e) { showMsg(errText(e)); } finally { setBusy(false); if (input.current) input.current.value = ''; }
    };

    const removeFile = async (f: HwFile) => {
        try { await api('DELETE', `/homework/files/${f.id}`); onChanged(); } catch (e) { showMsg(errText(e)); }
    };

    return (
        <div className="hw">
            <div className="hw-head">
                <span className="hw-title">Домашнее задание</span>
                {canEdit && !editing && <button className="btn btn--tonal btn--sm" onClick={() => { setDraft(body); setEditing(true); }}>{body ? 'Изменить' : 'Добавить'}</button>}
            </div>

            {editing ? (
                <div className="stack" style={{ gap: 8 }}>
                    <textarea className="field" autoFocus maxLength={5000} placeholder="Что задано?" value={draft} onChange={e => setDraft(e.target.value)} />
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <button className="btn btn--tonal btn--sm" disabled={busy} onClick={() => setEditing(false)}>Отмена</button>
                        <button className="btn btn--primary btn--sm" disabled={busy} onClick={save}>Сохранить</button>
                    </div>
                </div>
            ) : body ? <p className="hw-body">{body}</p> : <p className="hw-empty">Не задано</p>}

            <div className="hw-head">
                <span className="hw-title">Файлы</span>
                {canEdit && (
                    <>
                        <input ref={input} type="file" multiple hidden accept={ACCEPT} onChange={e => upload(e.target.files)} />
                        <button className="btn btn--tonal btn--sm" disabled={busy} onClick={() => input.current?.click()}><IcoPlus /> Загрузить</button>
                    </>
                )}
            </div>
            {files.length === 0 ? <p className="hw-empty">Файлов нет</p> : (
                <ul className="hw-files">
                    {files.map(f => (
                        <li key={f.id} className="hw-pill">
                            <a className="hw-pill-link" href={`/api/homework/files/${f.id}`} download={f.name} title={`Скачать · ${f.name}`}>
                                <IcoClip />
                                <span className="hw-pill-name">{f.name}</span>
                                <span className="hw-pill-size">{fmtSize(f.size)}</span>
                                <IcoDownload />
                            </a>
                            {canEdit && <button className="hw-pill-x" aria-label={`Удалить ${f.name}`} title="Удалить" onClick={() => removeFile(f)}><IcoTrash /></button>}
                        </li>
                    ))}
                </ul>
            )}
            {canEdit && <p className="hint">Документы и картинки до {MAX_MB} МБ, не больше 5 файлов на пару</p>}
        </div>
    );
}
