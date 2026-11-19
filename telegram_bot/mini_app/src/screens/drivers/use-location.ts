import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { LatLng } from '../../../../../support/common/driver-route';
import { telegramLocation } from '../../lib/telegram';
import type { Fix } from './drive-shared';

const toFix = (p: GeolocationPosition): Fix => ({ lat: p.coords.latitude, lng: p.coords.longitude, heading: p.coords.heading ?? null, speed: p.coords.speed ?? null, accuracy: p.coords.accuracy ?? null });

/**
 * Where the driver is. The latest fix is kept in `fix` (read every frame, outside React); React state
 * changes only on big moves. `onFix` hears every fix with the one before it (the arrow, the trip record).
 */
export function useLocation(onFix: MutableRefObject<(f: Fix, prev: Fix | null) => void>) {
  const fix = useRef<Fix | null>(null);
  const [myPos, setMyPos] = useState<LatLng | null>(null);
  const [myAcc, setMyAcc] = useState<number | null>(null);
  const [posErr, setPosErr] = useState('');
  const accept = useCallback((f: Fix) => {
    const prev = fix.current;
    fix.current = f;
    setPosErr('');
    if (!prev || Math.abs(prev.lat - f.lat) + Math.abs(prev.lng - f.lng) > 0.003) setMyPos({ lat: f.lat, lng: f.lng });
    setMyAcc(f.accuracy != null ? Math.round(f.accuracy / 5) * 5 : null);
    onFix.current(f, prev);
  }, [onFix]);
  useEffect(() => {
    let poll = 0;
    let id: number | null = null;
    // The page's own location is blocked (some Telegram apps): Telegram's location instead.
    const viaTelegram = () => {
      if (poll) return;
      const tick = () => telegramLocation().then((f) => {
        if (f) accept(f);
        else if (!fix.current) setPosErr('Location is off. Allow it, or type where you start from.');
      });
      void tick();
      poll = window.setInterval(tick, 3000);
    };
    if (!navigator.geolocation) viaTelegram();
    else id = navigator.geolocation.watchPosition((p) => accept(toFix(p)), viaTelegram, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
    // Inside Telegram the page's own location can stay silent (no answer, no error): Telegram's too.
    const late = window.setTimeout(() => { if (!fix.current) viaTelegram(); }, 4000);
    return () => { if (id != null) navigator.geolocation.clearWatch(id); clearInterval(poll); clearTimeout(late); };
  }, [accept]);
  /**
   * A fresh, precise fix now (the "use my location" and locate buttons): the phone's location, and
   * Telegram's as soon as the phone's fails or is slow (1.5 s); the first answer wins, 10 s at most.
   */
  const locateNow = useCallback(() => new Promise<Fix | null>((resolve) => {
    let done = false, waiting = 0, tgAsked = false;
    const end = (f: Fix | null) => { if (done) return; done = true; clearTimeout(cap); clearTimeout(slow); if (f) accept(f); resolve(f ?? fix.current); };
    const answer = (f: Fix | null) => { if (f) end(f); else if (--waiting <= 0 && (tgAsked || !navigator.geolocation)) end(null); };
    const askTelegram = () => { if (tgAsked || done) return; tgAsked = true; waiting++; void telegramLocation().then(answer, () => answer(null)); };
    const cap = window.setTimeout(() => end(null), 10_000);
    const slow = window.setTimeout(askTelegram, 1500);
    if (!navigator.geolocation) { askTelegram(); return; }
    waiting++;
    navigator.geolocation.getCurrentPosition((p) => answer(toFix(p)), () => { askTelegram(); answer(null); }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 10_000 });
  }), [accept]);
  return { fix, myPos, myAcc, posErr, locateNow };
}
