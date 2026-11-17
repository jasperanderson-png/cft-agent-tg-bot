import { useEffect, useRef } from 'react';

/** The subset of Telegram.WebApp (Bot API 8.0+) this app uses. Older clients may lack some members. */
interface Insets { top: number; bottom: number; left: number; right: number }
interface TgButton { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void }
interface TgWebApp {
  initData: string;
  initDataUnsafe: { start_param?: string; user?: { first_name?: string; last_name?: string } };
  platform: string;
  version: string;
  isFullscreen?: boolean;
  safeAreaInset?: Insets;
  contentSafeAreaInset?: Insets;
  ready(): void;
  expand(): void;
  close(): void;
  isVersionAtLeast(v: string): boolean;
  requestFullscreen?(): void;
  disableVerticalSwipes?(): void;
  enableClosingConfirmation(): void;
  disableClosingConfirmation(): void;
  setHeaderColor(c: string): void;
  setBackgroundColor(c: string): void;
  setBottomBarColor?(c: string): void;
  onEvent(e: string, cb: () => void): void;
  openTelegramLink(url: string): void;
  openLink(url: string): void;
  downloadFile?(p: { url: string; file_name: string }, cb?: (accepted: boolean) => void): void;
  BackButton: TgButton;
  /** Bot API 8.0: the location from Telegram itself, where the page's own location request is blocked. */
  LocationManager?: {
    isInited: boolean; isLocationAvailable: boolean; isAccessGranted: boolean; isAccessRequested: boolean;
    init(cb?: () => void): void;
    getLocation(cb: (d: { latitude: number; longitude: number; horizontal_accuracy?: number | null; course?: number | null; speed?: number | null } | null) => void): void;
    openSettings(): void;
  };
  HapticFeedback?: { impactOccurred(s: string): void; notificationOccurred(t: 'error' | 'success' | 'warning'): void; selectionChanged(): void };
}

declare global {
  interface Window {
    Telegram?: { WebApp: TgWebApp };
  }
}

const wa = typeof window !== 'undefined' ? window.Telegram?.WebApp : undefined;
/** True only inside a Telegram client (the SDK script also loads in a normal browser, with empty initData). */
export const tg: TgWebApp | null = wa && wa.initData ? wa : null;
export const initData = tg?.initData ?? '';
export const startParam = tg?.initDataUnsafe.start_param ?? '';

/**
 * The address of the drivers' map page (/route), with the Telegram session in it the way Telegram
 * itself passes it, so the new page is signed in even if the WebView forgot it on the way.
 */
export function routePageUrl(): string {
  if (!tg) return '/route';
  const p = new URLSearchParams({ tgWebAppData: tg.initData, tgWebAppVersion: tg.version, tgWebAppPlatform: tg.platform });
  return `/route${location.search.includes('simulate') ? '?simulate' : ''}#${p.toString()}`;
}
const MOBILE = ['ios', 'android', 'android_x'];
const at = (v: string) => !!tg?.isVersionAtLeast(v);

function setInsets(prefix: string, i: Partial<Insets> | undefined) {
  const s = document.documentElement.style;
  for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    if (typeof i?.[side] === 'number') s.setProperty(`--${prefix}-${side}`, `${i[side]}px`);
  }
}

function syncInsets() {
  if (!tg) return;
  // Device safe area (notch, home indicator) + the area Telegram's own controls cover in fullscreen.
  setInsets('sa', tg.safeAreaInset);
  setInsets('csa', tg.contentSafeAreaInset);
  document.documentElement.dataset.fullscreen = tg.isFullscreen ? '1' : '0';
}

export function initTelegram() {
  const root = document.documentElement;
  if (import.meta.env.DEV) {
    // Preview safe areas in a desktop browser: ?insets=top,bottom,contentTop  e.g. ?insets=59,34,46
    const p = new URLSearchParams(location.search).get('insets');
    if (p) {
      const [t, b, ct] = p.split(',').map(Number);
      setInsets('sa', { top: t || 0, bottom: b || 0 });
      setInsets('csa', { top: ct || 0 });
    }
  }
  if (!tg) return;
  root.dataset.tg = '1';
  tg.ready();
  tg.expand();
  // Telegram keeps the Back button from the previous page (the route map is a page of its own):
  // every page starts with Close, and a screen shows Back only when it has somewhere to go back to.
  tg.BackButton.hide();
  try {
    tg.setHeaderColor('#000000');
    tg.setBackgroundColor('#000000');
    if (at('7.10')) tg.setBottomBarColor?.('#000000');
  } catch {
    /* older clients */
  }
  // Stop the swipe-down-to-close gesture from fighting with scrolling.
  if (at('7.7')) tg.disableVerticalSwipes?.();
  // Fullscreen on phones; desktop clients keep their window.
  if (at('8.0') && MOBILE.includes(tg.platform) && !tg.isFullscreen) {
    try {
      tg.requestFullscreen?.();
    } catch {
      /* unsupported: stay expanded */
    }
  }
  syncInsets();
  for (const e of ['safeAreaChanged', 'contentSafeAreaChanged', 'fullscreenChanged', 'viewportChanged']) tg.onEvent(e, syncInsets);
}

/** Shows Telegram's native back button while `onBack` is set. */
export function useBackButton(onBack: (() => void) | null) {
  const ref = useRef(onBack);
  ref.current = onBack;
  const active = !!onBack;
  useEffect(() => {
    if (!tg || !active) return;
    const cb = () => ref.current?.();
    tg.BackButton.onClick(cb);
    tg.BackButton.show();
    return () => {
      tg!.BackButton.offClick(cb);
      tg!.BackButton.hide();
    };
  }, [active]);
}

/** Asks Telegram to confirm before closing while there is unsaved work. */
export function useClosingConfirmation(on: boolean) {
  useEffect(() => {
    if (!tg) return;
    if (on) tg.enableClosingConfirmation();
    else tg.disableClosingConfirmation();
    return () => tg!.disableClosingConfirmation();
  }, [on]);
}

export const haptic = {
  select: () => tg?.HapticFeedback?.selectionChanged(),
  success: () => tg?.HapticFeedback?.notificationOccurred('success'),
  error: () => tg?.HapticFeedback?.notificationOccurred('error'),
  tap: () => tg?.HapticFeedback?.impactOccurred('light'),
};

/** Telegram's in-app browser can't save blob downloads; hand it a URL instead. */
export function canTelegramDownload() {
  return !!tg?.downloadFile && at('8.0');
}

export function telegramDownload(url: string, fileName: string) {
  tg?.downloadFile?.({ url, file_name: fileName });
}

/** Opens a web page (for example Google Maps) outside the Mini App. */
export function openExternal(url: string) {
  if (tg) tg.openLink(url);
  else window.open(url, '_blank', 'noopener');
}

/** Closes the Mini App and returns to the chat. */
export function backToChat() {
  if (tg) tg.close();
}

export interface TgFix { lat: number; lng: number; accuracy: number | null; heading: number | null; speed: number | null }
/** Telegram asked for location access and the person said no: only Telegram's settings can undo it. */
export const telegramLocationRefused = () => {
  const lm = tg && at('8.0') ? tg.LocationManager : undefined;
  return !!lm?.isInited && lm.isAccessRequested && !lm.isAccessGranted;
};
/** Opens Telegram's location settings for this app (must run from a tap). */
export const openTelegramLocationSettings = () => {
  try { tg?.LocationManager?.openSettings(); } catch { /* older Telegram */ }
};
/** One location from Telegram's own location access (asks the person once), or null if unavailable. */
export function telegramLocation(): Promise<TgFix | null> {
  const lm = tg && at('8.0') ? tg.LocationManager : undefined;
  if (!lm) return Promise.resolve(null);
  return new Promise((resolve) => {
    const get = () => {
      if (!lm.isLocationAvailable) { resolve(null); return; }
      lm.getLocation((d) => resolve(d ? { lat: d.latitude, lng: d.longitude, accuracy: d.horizontal_accuracy ?? null, heading: d.course ?? null, speed: d.speed ?? null } : null));
    };
    if (lm.isInited) get();
    else lm.init(get);
  });
}
