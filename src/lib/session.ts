const STORAGE_KEY = "zonewars_session_token";

export function getSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(STORAGE_KEY);
}

export function setSessionToken(token: string): void {
  localStorage.setItem(STORAGE_KEY, token);
}

export function clearSessionToken(): void {
  localStorage.removeItem(STORAGE_KEY);
}
