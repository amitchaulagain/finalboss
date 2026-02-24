<script lang="ts">
  import type { TemplateMetadata, ResumeData } from '../types';
  import { getHtmlGenerator } from '$lib/resume/templates/html';

  interface PreviewOverrides {
    name?: string;
    title?: string;
    email?: string;
    phone?: string;
    linkedin?: string;
  }

  interface Props {
    template: TemplateMetadata;
    previewData?: PreviewOverrides | null;
  }

  let { template, previewData = null }: Props = $props();

  // Static sample resume used as the base for the preview.
  // templateId is set to empty string here and overridden reactively in sampleResume.
  const baseSample: ResumeData = {
    id: 'preview-sample',
    title: 'Preview',
    createdAt: '',
    updatedAt: '',
    templateId: '',
    personalInfo: {
      fullName: 'John Doe',
      title: 'Software Engineer',
      email: 'john.doe@email.com',
      phone: '+1 (555) 123-4567',
      linkedin: 'linkedin.com/in/johndoe',
    },
    summary: 'Experienced Software Engineer with 5+ years of expertise in full-stack development, cloud architecture, and team leadership.',
    experience: [
      {
        id: 'e1',
        jobTitle: 'Senior Software Engineer',
        company: 'Tech Innovations Inc.',
        location: 'San Francisco, CA',
        startDate: 'Jan 2020',
        endDate: null,
        achievements: [
          'Led team of 5 engineers to develop SaaS platform serving 100K+ users',
          'Reduced application response time by 40% through optimization',
        ],
      },
      {
        id: 'e2',
        jobTitle: 'Software Engineer',
        company: 'Digital Solutions Co.',
        location: 'New York, NY',
        startDate: 'Jun 2018',
        endDate: 'Dec 2019',
        achievements: [
          'Developed RESTful APIs handling 1M+ requests per day',
        ],
      },
    ],
    education: [
      {
        id: 'edu1',
        degree: 'B.S. Computer Science',
        institution: 'University of Technology',
        location: 'Boston, MA',
        graduationDate: '2018',
      },
    ],
    skills: [
      { id: 's1', name: 'JavaScript', category: 'Programming' },
      { id: 's2', name: 'TypeScript', category: 'Programming' },
      { id: 's3', name: 'React', category: 'Frameworks' },
      { id: 's4', name: 'Node.js', category: 'Frameworks' },
      { id: 's5', name: 'AWS', category: 'Tools' },
      { id: 's6', name: 'Docker', category: 'Tools' },
    ],
    certifications: [
      { id: 'c1', name: 'AWS Certified Solutions Architect', issuer: 'Amazon Web Services', date: '2021' },
    ],
    languages: [
      { id: 'l1', name: 'English', proficiency: 'Native' },
      { id: 'l2', name: 'French', proficiency: 'Intermediate' },
    ],
  };

  // Merge caller-supplied overrides into the sample (only personalInfo fields)
  const sampleResume: ResumeData = $derived(
    previewData
      ? {
          ...baseSample,
          templateId: template.id,
          personalInfo: {
            ...baseSample.personalInfo,
            ...(previewData.name ? { fullName: previewData.name } : {}),
            ...(previewData.title ? { title: previewData.title } : {}),
            ...(previewData.email ? { email: previewData.email } : {}),
            ...(previewData.phone ? { phone: previewData.phone } : {}),
            ...(previewData.linkedin ? { linkedin: previewData.linkedin } : {}),
          },
        }
      : { ...baseSample, templateId: template.id }
  );

  const html: string = $derived(getHtmlGenerator(template.id)(sampleResume));
</script>

<!-- Scaled A4 iframe preview card -->
<div class="preview-outer">
  <iframe
    srcdoc={html}
    title="{template.name} preview"
    scrolling="no"
    sandbox="allow-same-origin"
    class="preview-iframe"
  ></iframe>
</div>

<style>
  /*
   * A4 at 96 dpi ≈ 794 × 1123 px.
   * We scale to ~38% so the visual size is ≈ 302 × 427 px,
   * which fits comfortably inside the 400px-tall card figure.
   */
  .preview-outer {
    width: 302px;   /* 794 * 0.38 */
    height: 410px;  /* 1080 * 0.38 — slight clip at bottom is intentional */
    overflow: hidden;
    position: relative;
    border: 1px solid #e5e7eb;
    border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    background: white;
  }

  .preview-iframe {
    width: 794px;   /* 210mm at 96dpi */
    height: 1123px; /* 297mm at 96dpi */
    border: none;
    display: block;
    transform: scale(0.38);
    transform-origin: top left;
    pointer-events: none;
  }
</style>
