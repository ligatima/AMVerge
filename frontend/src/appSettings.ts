export type AppSettings = {
  useImprovedDetection: boolean;
};

const STORAGE_KEY = "amverge.settings.v1";

const DEFAULTS: AppSettings = {
  useImprovedDetection: true,
};

export function loadAppSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      useImprovedDetection:
        typeof parsed.useImprovedDetection === "boolean"
          ? parsed.useImprovedDetection
          : DEFAULTS.useImprovedDetection,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveAppSettings(s: AppSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}
