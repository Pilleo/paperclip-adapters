export interface VibeModel {
  id: string;
  label: string;
}

export const THINKING_LEVELS = ["high", "medium", "low", "max", "off"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const VIBE_MODELS: VibeModel[] = [
  { id: "mistral-medium-3.5", label: "Mistral Medium 3.5 (Default)" },
  { id: "devstral-small", label: "Devstral Small" },
  { id: "local", label: "Devstral (Local llama.cpp)" },
  { id: "codestral-latest", label: "Codestral Latest (Mistral Code)" },
  { id: "mistral-large-latest", label: "Mistral Large Latest" },
];

export const DEFAULT_VIBE_MODEL = "mistral-medium-3.5";
