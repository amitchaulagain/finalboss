import type { ResumeData } from '../../types';
import { generate as creativeMulticolumn } from './creative-multicolumn';
import { generate as modernMinimal } from './modern-minimal';

type Generator = (
  resume: ResumeData,
  sectionTitles?: Record<string, string>,
  hiddenSections?: string[]
) => string;

const generators: Record<string, Generator> = {
  'creative-multicolumn': creativeMulticolumn,
  'modern-minimal': modernMinimal,
};

export function getHtmlGenerator(templateId: string): Generator {
  return generators[templateId] ?? generators['modern-minimal'];
}

/** HTML-escape helper — safe to use in template string interpolations */
export function escHtml(s: string | undefined | null): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
