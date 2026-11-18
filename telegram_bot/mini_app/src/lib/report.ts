import { tg } from './telegram';

// Errors on the drivers' map page go to the server log (journalctl -u cft-agent), the only place a phone's error can be read.

/** Sends what went wrong on the map page to the server log (the only way to see a phone's error). */
const sent = new Set<string>();
export function reportMapError(message: string, stack?: string) {
  if (sent.has(message) || sent.size >= 10) return; // each error once, at most 10 per page
  sent.add(message);
  try {
    const body = JSON.stringify({ message: String(message).slice(0, 500), stack: String(stack ?? '').slice(0, 1500), ua: navigator.userAgent.slice(0, 200), platform: tg?.platform ?? 'browser', version: tg?.version ?? '', signedIn: !!tg });
    void fetch('/api/driver/log', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
  } catch {
    /* nothing more to do */
  }
}
