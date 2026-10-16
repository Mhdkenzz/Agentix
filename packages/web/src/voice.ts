// Browser speech: push-to-talk recognition and spoken replies (Chrome/Edge).
type Rec = {
  lang: string; interimResults: boolean; continuous: boolean;
  onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null;
  start(): void; stop(): void; abort(): void;
};

const Recognition: (new () => Rec) | undefined =
  (globalThis as any).SpeechRecognition ?? (globalThis as any).webkitSpeechRecognition;

export const canListen = !!Recognition;
export const canSpeak = typeof speechSynthesis !== 'undefined';

/** Start listening; returns stop(). onText gets the transcript so far, onDone the final one. */
export function listen(onText: (t: string) => void, onDone: (t: string) => void, onError: (msg: string) => void): () => void {
  if (!Recognition) { onError('Speech recognition needs Chrome or Edge.'); return () => {}; }
  const rec = new Recognition();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = true;
  rec.continuous = true;
  let finalText = '';
  let interim = '';
  rec.onresult = (e: any) => {
    interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
    }
    onText((finalText + interim).trim());
  };
  rec.onerror = (e: any) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    onError(e.error === 'not-allowed' ? 'Microphone access was blocked.' : e.error === 'network' ? 'Speech recognition needs internet.' : `Speech error: ${e.error}`);
  };
  rec.onend = () => onDone((finalText + interim).trim());
  rec.start();
  return () => rec.stop();
}

export function speak(text: string, voiceName?: string): void {
  if (!canSpeak || !text.trim()) return;
  const u = new SpeechSynthesisUtterance(text);
  const v = voiceName && speechSynthesis.getVoices().find(x => x.name === voiceName);
  if (v) u.voice = v;
  u.rate = 1.05;
  speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if (canSpeak) speechSynthesis.cancel();
}
