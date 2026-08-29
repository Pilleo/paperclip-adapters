export interface AntigravityModel {
  id: string;
  label: string;
}

export const ANTIGRAVITY_MODELS: AntigravityModel[] = [
  { id: "gemini-pro-agent", label: "Gemini 3.1 Pro (High)" },
  { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
  { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
  { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)" },
  { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" },
  { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
  { id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)" },
  { id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)" },
  { id: "gemini-3-flash-agent", label: "Gemini 3.5 Flash (High)" },
  { id: "gemini-3.5-flash-low", label: "Gemini 3.5 Flash (Medium)" },
  { id: "gemini-3.5-flash-extra-low", label: "Gemini 3.5 Flash (Low)" },
];

export const DEFAULT_ANTIGRAVITY_MODEL = "gemini-pro-agent";
