import { create } from "zustand";

interface PreferencesState {
  apiKey: string;
  showActionCenter: boolean;
  setApiKey: (key: string) => void;
  toggleActionCenter: () => void;
}

const STORAGE_KEY = "mw_api_key";

const initialKey = (() => {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(STORAGE_KEY) || "";
})();

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  apiKey: initialKey,
  showActionCenter: false,
  setApiKey: (apiKey) => {
    set({ apiKey });
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY, apiKey);
    }
  },
  toggleActionCenter: () => set({ showActionCenter: !get().showActionCenter }),
}));
