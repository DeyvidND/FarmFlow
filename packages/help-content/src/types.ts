// packages/help-content/src/types.ts

export type HelpSurface = 'panel' | 'delivery';

export interface CategoryDef {
  id: string;
  label: string;
}

export interface FaqEntry {
  id: string;
  category: string;
  question: string;
  answer: string;
  /** Extra search terms not already present in the question/answer text. */
  keywords?: string[];
}
