import { useEffect, useState } from 'react';
import { ApiError, adminApi, hasAdminToken, setAdminToken } from './api';
import { firstName, initData, signedIn } from './telegram';

export type AdminSession = { phase: 'checking' } | { phase: 'ready'; name: string } | { phase: 'denied'; message: string };

/**
 * Signs an admin in for the Hub and its screens: reuses the session from this visit, or signs in
 * with the Telegram account in one step. Anyone who is not a CFT admin gets `denied`.
 */
export function useAdminSession(): AdminSession {
  const [s, setS] = useState<AdminSession>({ phase: 'checking' });
  useEffect(() => {
    let live = true;
    (async () => {
      const first = firstName;
      if (hasAdminToken()) {
        try {
          const me = await adminApi.me();
          if (live) setS({ phase: 'ready', name: first || me.name || 'Admin' });
          return;
        } catch {
          setAdminToken('');
        }
      }
      if (!signedIn) {
        if (live) setS({ phase: 'denied', message: 'Open the CFT Hub from the bot in Telegram.' });
        return;
      }
      try {
        const r = await adminApi.telegramLogin(initData);
        setAdminToken(r.token);
        // On the website Telegram doesn't hand over the first name: the admin's own record has it.
        const name = first || (await adminApi.me().then((me) => me.name?.split(' ')[0], () => '')) || 'Admin';
        if (live) setS({ phase: 'ready', name });
      } catch (e) {
        if (live) setS({ phase: 'denied', message: (e as ApiError).status === 403 ? 'The CFT Hub is for CFT administrators.' : (e as ApiError).message });
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  return s;
}
