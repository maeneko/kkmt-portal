import { useRef, useState } from 'react';
import { api, errText } from '../../lib/api';
import { IcoClip, IcoDownload, IcoPlus, IcoTrash } from '../../components/icons';
import Linkify from '../../components/Linkify';
import { subjectAt, type Lesson } from '.';

export interface HwFile { id: number; name: string; size: number; note: string; author: string }
// solution — эталонное решение этой пары (подставляется в «Материалах»)
export interface HwItem { date: string; pair_no: number; body: string; files: HwFile[]; solution?: HwItem }

// Общие материалы — слот ДЗ с этой датой и парой 0 (так же на сервере)
export const GENERAL = '1000-01-01';
// Эталонное решение пары N — слот с номером пары N + SOLUTION (так же на сервере)
export const SOLUTION = 100;
export const hasContent = (i?: HwItem) => !!i && (!!i.body || i.files.length > 0);
const MAX_MB = 50;
const ddmm = (d: string) => `${d.slice(8)}.${d.slice(5, 7)}`;

// Файлы ДЗ: подпись «что сделать», сам файл; файлы одного автора собраны в одну карточку с общей строкой «Добавлено».
// С onNote подпись редактируется (сохраняется при уходе с поля).
export function FileList({ files, onRemove, onNote }: { files: HwFile[]; onRemove?: (f: HwFile) => void; onNote?: (f: HwFile, note: string) => void }) {
    const groups: { author: string; files: HwFile[] }[] = [];
    for (const f of files) {
        const g = groups.find(x => x.author === f.author);
        if (g) g.files.push(f); else groups.push({ author: f.author, files: [f] });
    }
    return (
        <ul className="hw-files">
            {groups.map(g => (
                <li key={g.author} className="hw-file-item">
                    {g.files.map(f => (
                        <div key={f.id} className="hw-file-entry">
                            {onNote ? (
                                <textarea key={f.note} className="hw-note-in" rows={1} maxLength={500} placeholder="Что сделать в этом файле" defaultValue={f.note}
                                          ref={el => { if (el) { el.style.height = '0'; el.style.height = `${el.scrollHeight + 2}px`; } }}
                                          onInput={e => { const el = e.currentTarget; el.style.height = '0'; el.style.height = `${el.scrollHeight + 2}px`; }}
                                          onBlur={e => { if (e.target.value.trim() !== f.note) onNote(f, e.target.value.trim()); }} />
                            ) : f.note && <p className="hw-note"><Linkify text={f.note} /></p>}
                            <div className="hw-pill">
                                <a className="hw-pill-link" href={`/api/homework/files/${f.id}`} download={f.name} title={`Скачать · ${f.name}`}>
                                    <IcoClip />
                                    <span className="hw-pill-name">{f.name}</span>
                                    <span className="hw-pill-size">{fmtSize(f.size)}</span>
                                    <IcoDownload />
                                </a>
                                {onRemove && <button className="hw-pill-x" aria-label={`Удалить ${f.name}`} title="Удалить" onClick={() => onRemove(f)}><IcoTrash /></button>}
                            </div>
                        </div>
                    ))}
                    {g.author && <span className="hw-author">Добавлено: {g.author}</span>}
                </li>
            ))}
        </ul>
    );
}

const ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.odg,.txt,.zip,.jpg,.jpeg,.png';
export const fmtSize = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(b / 1024))} КБ`);

// Домашнее задание и файлы к паре: читают все, добавляют и меняют админы/староста.
// Файлы прошлых занятий по этому же предмету можно прикрепить повторно, без новой загрузки.
// part — показать только текст (body) или только файлы (files), без рамки: для зон в «Материалах».
export default function HomeworkBlock({ date, pair, item, canEdit, onChanged, showMsg, subject, lessons, semesterStart, part }: {
    date: string; pair: number; item?: HwItem; canEdit: boolean; onChanged: () => void; showMsg: (t: string) => void;
    subject: string; lessons: Lesson[]; semesterStart: string | null; part?: 'body' | 'files';
}) {
    const body = item?.body ?? '';
    const files = item?.files ?? [];
    const general = pair === 0;
    const solution = pair > SOLUTION;
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<{ name: string; pct: number } | null>(null);
    const input = useRef<HTMLInputElement>(null);
    const [old, setOld] = useState<(HwFile & { date: string })[] | null>(null);

    const save = async () => {
        setBusy(true);
        try { await api('PUT', '/homework', { date, pair_no: pair, body: draft }); setEditing(false); onChanged(); }
        catch (e) { showMsg(errText(e)); } finally { setBusy(false); }
    };

    // XHR, а не fetch: только он сообщает, сколько уже отправлено
    const send = (f: File, onProgress: (pct: number) => void) => new Promise<void>((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open('POST', `/api/homework/files?date=${date}&pair_no=${pair}&name=${encodeURIComponent(f.name)}`);
        x.setRequestHeader('Content-Type', 'application/octet-stream');
        x.upload.onprogress = e => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
        x.onerror = () => reject(new Error('Нет соединения'));
        x.onload = () => {
            if (x.status < 300) return resolve();
            // 413 не в нашем JSON — его отдал nginx перед приложением (у него свой лимит на размер запроса)
            let msg = x.status === 413 ? 'Сервер не принял файл: превышен лимит nginx (client_max_body_size)' : `Ошибка ${x.status}`;
            try { msg = JSON.parse(x.responseText).error ?? msg; } catch { /* не JSON */ }
            reject(new Error(msg));
        };
        x.send(f);
    });

    const upload = async (list: FileList | null) => {
        if (!list?.length) return;
        setBusy(true);
        try {
            for (const f of Array.from(list)) {
                if (f.size > MAX_MB * 1048576) { showMsg(`«${f.name}» больше ${MAX_MB} МБ`); continue; }
                setProgress({ name: f.name, pct: 0 });
                await send(f, pct => setProgress({ name: f.name, pct }));
            }
            onChanged();
        } catch (e) { showMsg(errText(e)); } finally { setBusy(false); setProgress(null); if (input.current) input.current.value = ''; }
    };

    const removeFile = async (f: HwFile) => {
        try { await api('DELETE', `/homework/files/${f.id}`); onChanged(); } catch (e) { showMsg(errText(e)); }
    };
    const saveNote = async (f: HwFile, note: string) => {
        try { await api('PATCH', `/homework/files/${f.id}`, { note }); onChanged(); } catch (e) { showMsg(errText(e)); }
    };

    // Старые файлы этого предмета (новые сверху, без повторов и без уже прикреплённых)
    const toggleOld = async () => {
        if (old) return setOld(null);
        try {
            const { items } = await api<{ items: HwItem[] }>('GET', `/homework?from=${semesterStart ?? `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`}&to=${date}`);
            const seen = new Set(files.map(f => `${f.name}|${f.size}`));
            const list: (HwFile & { date: string })[] = [];
            for (const it of items.sort((a, b) => b.date.localeCompare(a.date))) {
                if ((it.date === date && it.pair_no === pair) || subjectAt(lessons, semesterStart, it.date, it.pair_no) !== subject) continue;
                for (const f of it.files) if (!seen.has(`${f.name}|${f.size}`)) { seen.add(`${f.name}|${f.size}`); list.push({ ...f, date: it.date }); }
            }
            setOld(list);
        } catch (e) { showMsg(errText(e)); }
    };
    const attach = async (f: HwFile) => {
        setBusy(true);
        try { await api('POST', `/homework/files/${f.id}/attach`, { date, pair_no: pair }); setOld(o => o?.filter(x => x.id !== f.id) ?? null); onChanged(); }
        catch (e) { showMsg(errText(e)); } finally { setBusy(false); }
    };

    return (
        <div className={`hw${solution ? ' hw--solution' : ''}${part ? ' hw--bare' : ''}`}>
            {part !== 'files' && <>
            <div className="hw-head">
                <span className="hw-title">{general ? 'Описание' : solution ? 'Эталонное решение' : 'Домашнее задание'}</span>
                {canEdit && !editing && <button className="btn btn--tonal btn--sm" onClick={() => { setDraft(body); setEditing(true); }}>{body ? 'Изменить' : 'Добавить'}</button>}
            </div>

            {editing ? (
                <div className="stack" style={{ gap: 8 }}>
                    <textarea className="field" autoFocus maxLength={5000} placeholder={general ? 'Описание' : solution ? 'Как решать, ответ' : 'Что задано?'} value={draft} onChange={e => setDraft(e.target.value)} />
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <button className="btn btn--tonal btn--sm" disabled={busy} onClick={() => setEditing(false)}>Отмена</button>
                        <button className="btn btn--primary btn--sm" disabled={busy} onClick={save}>Сохранить</button>
                    </div>
                </div>
            ) : body ? <p className="hw-body"><Linkify text={body} /></p> : <p className="hw-empty">{general ? 'Ничего нет' : solution ? 'Не добавлено' : 'Не задано'}</p>}
            </>}

            {part !== 'body' && <>
            <div className="hw-head">
                <span className="hw-title">Файлы</span>
                {canEdit && (
                    <>
                        <input ref={input} type="file" multiple hidden accept={ACCEPT} onChange={e => upload(e.target.files)} />
                        <div className="row" style={{ gap: 6 }}>
                            {!general && !solution && <button className="btn btn--outline btn--sm" disabled={busy} aria-expanded={!!old} onClick={toggleOld}>Из прошлых</button>}
                            <button className="btn btn--tonal btn--sm" disabled={busy} onClick={() => input.current?.click()}><IcoPlus /> Загрузить</button>
                        </div>
                    </>
                )}
            </div>
            {old && (
                <div className="hw-old">
                    <span className="hint">Файлы прошлых занятий «{subject}» — нажмите, чтобы прикрепить</span>
                    {old.length === 0 ? <p className="hw-empty">Раньше файлов не было</p> : old.map(f => (
                        <button key={f.id} className="hw-old-item" disabled={busy} onClick={() => attach(f)}>
                            <IcoPlus /><span className="hw-pill-name">{f.name}</span><span className="hw-pill-size">{ddmm(f.date)}</span>
                        </button>
                    ))}
                </div>
            )}
            {progress && (
                <div className="hw-progress">
                    <span className="hw-progress-name"><span className="hw-pill-name">{progress.name}</span><b>{progress.pct}%</b></span>
                    <div className="hw-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.pct}><i style={{ width: `${progress.pct}%` }} /></div>
                </div>
            )}
            {files.length === 0 ? <p className="hw-empty">Файлов нет</p>
                : <FileList files={files} onRemove={canEdit ? removeFile : undefined} onNote={canEdit ? saveNote : undefined} />}
            {canEdit && <p className="hint">Документы и картинки до {MAX_MB} МБ{!general && ', не больше 5 файлов на пару'}</p>}
            </>}
        </div>
    );
}
