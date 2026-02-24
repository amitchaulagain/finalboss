/**
 * Resume Builder Data Types and Interfaces
 * Based on ATS-friendly resume.io templates
 */

export interface ContactExtra {
  id: string;
  label: string;
  value: string;
}

export interface PersonalInfo {
  fullName: string;
  title: string;
  email: string;
  phone: string;
  linkedin?: string;
  github?: string;
  website?: string;
  address?: string;
  contactExtras?: ContactExtra[];
}

export interface WorkExperience {
  id: string;
  jobTitle: string;
  company: string;
  location?: string;
  startDate: string;
  endDate: string | null; // null = present
  achievements: string[];
  technologies?: string[];
}

export interface Education {
  id: string;
  degree: string;
  institution: string;
  location?: string;
  graduationDate: string;
  gpa?: string;
  coursework?: string[];
  honors?: string[];
}

export interface Skill {
  id: string;
  name: string;
  category: string; // e.g., "Programming Languages", "Frameworks", "Tools"
}

export interface Certification {
  id: string;
  name: string;
  issuer: string;
  date: string;
  expiryDate?: string;
  credentialId?: string;
  credentialUrl?: string;
}

export interface Project {
  id: string;
  title: string;
  role?: string;
  organization?: string; // "Personal Project" or company name
  startDate?: string;
  endDate?: string | null;
  description: string[];
  technologies?: string[];
  url?: string;
}

export interface Language {
  id: string;
  name: string;
  proficiency: 'Native' | 'Fluent' | 'Advanced' | 'Intermediate' | 'Basic';
}

export interface CustomSection {
  id: string;
  type: 'custom';
  title: string;
  content: string[];
}

export interface ResumeData {
  id: string;
  title: string; // User-friendly resume name
  isBase?: boolean; // Marks this as the base/primary resume
  createdAt: string;
  updatedAt: string;
  templateId: string;
  
  // Personal Information
  personalInfo: PersonalInfo;
  
  // Main Sections
  summary?: string;
  experience: WorkExperience[];
  education: Education[];
  skills: Skill[];
  certifications?: Certification[];
  projects?: Project[];
  languages?: Language[];
  customSections?: CustomSection[];

  // Section customisation
  sectionTitles?: Record<string, string>;  // user-renamed section headings
  hiddenSections?: string[];               // section IDs hidden by user

  // Settings
  enablePageNumbers?: boolean;
  pageMargins?: {
    top: number;
    bottom: number;
    left: number;
    right: number;
  };
  
  // Font Customization (user overrides) - no longer exposed in UI, kept for backward compatibility
  fontSettings?: {
    headerFont: string;           // Font family for headers
    bodyFont: string;             // Font family for body text
    contactFont: string;          // Font family for contact info
    
    headerFontSize: number;       // Size in points (14-16)
    bodyFontSize: number;         // Size in points (10-12)
    contactFontSize: number;      // Size in points (9-11)
    nameFontSize: number;         // Size in points (16-18)
    
    letterSpacing: 'normal' | 'tight' | 'loose';
    lineSpacing: number;          // 1.0 = single spacing
    
    sectionSpacing: 'compact' | 'normal' | 'spacious';
    
    // Advanced options
    useTemplateFonts: boolean;    // If false, use custom fonts
  };
}

export interface TemplateStyle {
  // Colors
  primaryColor: string;      // Header/main accent (hex)
  secondaryColor: string;     // Secondary accents (hex)
  dividerColor: string;       // Section dividers (hex)
  textColor: string;          // Main text (hex)
  backgroundColor?: string;   // Background (hex, optional)
  
  // Fonts (web fonts for editor, mapped to DOCX fonts)
  headerFont: string;        // Font family for headers
  bodyFont: string;          // Font family for body text
  contactFont: string;        // Font family for contact info
  docxHeaderFont?: string;   // DOCX-compatible font for headers
  docxBodyFont?: string;     // DOCX-compatible font for body
  docxContactFont?: string;  // DOCX-compatible font for contact
  
  // Typography
  headerFontSize: number;    // Font size in points
  bodyFontSize: number;      // Font size in points
  contactFontSize: number;   // Font size in points
  headerFontWeight: 'normal' | 'bold' | '600' | '700' | '800';
  
  // Layout
  headerAlignment: 'left' | 'center' | 'right';
  contentAlignment: 'left' | 'center' | 'justified';
  sectionSpacing: number;    // Spacing after sections (in points)
  
  // Layout Structure
  layoutType?: 'single-column' | 'two-column' | 'three-column' | 'two-column-header' | 'two-column-sidebar' | 'two-column-split';
  leftColumnWidth?: number;    // Percentage for column layouts (e.g., 30, 40)
  rightColumnWidth?: number;   // Percentage for column layouts (e.g., 70, 60)
  middleColumnWidth?: number;  // Percentage for three-column layouts
  
  // Date Format
  dateFormat?: 'full' | 'month-year' | 'year-only' | 'month-year-short' | 'numeric' | 'numeric-short' | 'month-year-long' | 'year-present';
  dateSeparator?: string;      // e.g., "-", "/", "."
  showPresent?: boolean;        // Show "Present" vs "Current"
  
  // Bullet Style
  bulletStyle?: 'round' | 'square' | 'dash' | 'diamond' | 'arrow' | 'custom';
  bulletColor?: string;        // Color for custom bullets
  bulletCharacter?: string;    // Custom bullet character
  
  // Section Grouping (for column layouts)
  sidebarSections?: string[];  // Sections to show in sidebar (e.g., ['skills', 'languages'])
  mainSections?: string[];     // Sections to show in main area
  contactPlacement?: 'header' | 'sidebar' | 'both';
  
  // Special Features
  headerStyle: 'plain' | 'underline' | 'background' | 'border';
  dividerStyle: 'line' | 'dotted' | 'gradient' | 'none';
  showAccentBars: boolean;
  nameUppercase?: boolean;   // Whether the name should be rendered all-caps
}

export interface TemplateMetadata {
  id: string;
  name: string;
  description: string;
  category: 'traditional' | 'professional' | 'clean' | 'modern' | 'creative';
  previewImage?: string;
  atsCompliant: boolean;
  sections: TemplateSection[];
  style: TemplateStyle;
}

export interface TemplateSection {
  id: string;
  title: string;
  required: boolean;
  order: number;
  maxItems?: number; // For lists like experience, education
}

export interface ExportOptions {
  format: 'docx' | 'pdf' | 'txt';
  includePageNumbers?: boolean;
  margins?: ResumeData['pageMargins'];
}


