// Текст, в котором http(s)-адреса кликабельны (открываются в новой вкладке).
export default function Linkify({ text }: { text: string }) {
    return (
        <>
            {text.split(/(https?:\/\/[^\s]+)/).map((part, i) => i % 2
                ? <a key={i} className="text-link" href={part} target="_blank" rel="noopener noreferrer">{part}</a>
                : part)}
        </>
    );
}
