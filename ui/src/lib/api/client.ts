/**
 * API Client
 * Base request function and utilities
 */

import { usePreferencesStore } from '../../state/preferences-store';

interface RequestOptions extends RequestInit {
  skipAuth?: boolean;
}

/**
 * Make an API request with authentication
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  
  if (!options.skipAuth) {
    const token = usePreferencesStore.getState().apiKey.trim();
    if (token) {
      headers.set('Authorization', token.startsWith('Bearer ') ? token : `Bearer ${token}`);
    }
  }
  
  if (options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(path, { ...options, headers });
  
  if (!res.ok) {
    const payload = await safeJson(res);
    const message = (payload && (payload.error as string)) || res.statusText || 'Request failed';
    throw new Error(message);
  }
  
  return (await safeJson(res)) as T;
}

/**
 * Safely parse JSON response
 */
async function safeJson(res: Response) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text as unknown;
  }
}

export type { RequestOptions };
