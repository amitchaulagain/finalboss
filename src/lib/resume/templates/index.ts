/**
 * Resume Templates Registry
 * 4 templates based on DOCX reference files
 */

import type { TemplateMetadata } from '../types';
import {
  creativeMulticolumnStyle,
  modernMinimalStyle,
} from './configs';

export const TEMPLATES: TemplateMetadata[] = [
  {
    id: 'creative-multicolumn',
    name: 'Creative Multicolumn',
    description: 'Two-column layout with blue accents and sidebar for contact and skills.',
    category: 'professional',
    atsCompliant: true,
    style: creativeMulticolumnStyle,
    sections: [
      { id: 'personalInfo', title: 'Personal Information', required: true, order: 1 },
      { id: 'experience', title: 'Work Experience', required: true, order: 2, maxItems: 10 },
      { id: 'education', title: 'Education', required: true, order: 3, maxItems: 10 },
      { id: 'skills', title: 'Skills', required: true, order: 4 },
      { id: 'certifications', title: 'Certifications', required: false, order: 5 },
      { id: 'languages', title: 'Languages', required: false, order: 6 },
    ]
  },
  {
    id: 'modern-minimal',
    name: 'Modern Minimal',
    description: 'Clean single-column serif design with centered header and bold black section dividers.',
    category: 'clean',
    atsCompliant: true,
    style: modernMinimalStyle,
    sections: [
      { id: 'personalInfo', title: 'Personal Information', required: true, order: 1 },
      { id: 'summary', title: 'Summary', required: false, order: 2 },
      { id: 'experience', title: 'Experience', required: true, order: 3, maxItems: 10 },
      { id: 'education', title: 'Education', required: true, order: 4, maxItems: 10 },
      { id: 'skills', title: 'Skills', required: true, order: 5 },
      { id: 'certifications', title: 'Certifications', required: false, order: 6 },
      { id: 'languages', title: 'Languages', required: false, order: 7 },
    ]
  },
];

export function getTemplateById(id: string): TemplateMetadata | undefined {
  return TEMPLATES.find(t => t.id === id);
}

export function getTemplatesByCategory(category: TemplateMetadata['category']): TemplateMetadata[] {
  return TEMPLATES.filter(t => t.category === category);
}
