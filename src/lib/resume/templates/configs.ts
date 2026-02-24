/**
 * Resume Template Style Configurations
 */

import type { TemplateStyle } from '../types';

/**
 * Creative Multicolumn — blue accents, two-column split, sidebar contact
 * DOCX sections: Work Experience + Education (main) | Contact + Skills + Hobbies/Languages (sidebar)
 * No summary section.
 */
export const creativeMulticolumnStyle: TemplateStyle = {
  primaryColor: '#2F5496',
  secondaryColor: '#595959',
  dividerColor: '#2F5496',
  textColor: '#272727',
  backgroundColor: '#ffffff',
  headerFont: "'Source Sans Pro', Calibri, sans-serif",
  bodyFont: "'Source Sans Pro', Calibri, sans-serif",
  contactFont: "'Source Sans Pro', Calibri, sans-serif",
  docxHeaderFont: 'Calibri',
  docxBodyFont: 'Calibri',
  docxContactFont: 'Calibri',
  headerFontSize: 26,
  bodyFontSize: 10,
  contactFontSize: 9,
  headerFontWeight: '700',
  headerAlignment: 'left',
  contentAlignment: 'left',
  sectionSpacing: 160,
  layoutType: 'two-column-split',
  leftColumnWidth: 35,
  rightColumnWidth: 65,
  headerStyle: 'plain',
  dividerStyle: 'line',
  showAccentBars: false,
  nameUppercase: true,
  bulletStyle: 'dash',
  sidebarSections: ['skills', 'certifications', 'languages'],
  mainSections: ['experience', 'education'],
  contactPlacement: 'sidebar',
};

/**
 * Modern Minimal — single column, centered serif header, bold black section dividers
 * DOCX sections: Experience → Education → Skills (single column, no summary)
 */
export const modernMinimalStyle: TemplateStyle = {
  primaryColor: '#1a1a1a',
  secondaryColor: '#4495A2',
  dividerColor: '#1a1a1a',
  textColor: '#333333',
  backgroundColor: '#ffffff',
  headerFont: "Georgia, 'Times New Roman', serif",
  bodyFont: "Georgia, 'Times New Roman', serif",
  contactFont: "Georgia, 'Times New Roman', serif",
  docxHeaderFont: 'Georgia',
  docxBodyFont: 'Georgia',
  docxContactFont: 'Georgia',
  headerFontSize: 28,
  bodyFontSize: 10.5,
  contactFontSize: 10,
  headerFontWeight: 'bold',
  headerAlignment: 'center',
  contentAlignment: 'left',
  sectionSpacing: 200,
  layoutType: 'single-column',
  headerStyle: 'underline',
  dividerStyle: 'line',
  showAccentBars: false,
  bulletStyle: 'round',
  mainSections: ['experience', 'education', 'skills'],
  contactPlacement: 'header',
};


