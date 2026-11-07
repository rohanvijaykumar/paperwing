/**
 * Tool catalogue for the desktop shell: BentoPDF's tools (src/js/config/tools.ts)
 * regrouped the way Acrobat presents them, plus actions that run in the
 * built-in viewer (comment, redact...).
 */
import { categories } from '../js/config/tools';
import { desktop } from './desktop';

export type ViewerAction = 'comment' | 'redact' | 'certificate';

export interface AppTool {
  id: string;
  name: string;
  /** Phosphor icon name without the `ph-` prefix */
  icon: string;
  color: string;
  desc: string;
  /** Upstream tool page, e.g. "/compress-pdf.html" */
  href?: string;
  /** Runs inside the viewer instead of opening a tool page */
  action?: ViewerAction;
  /** Needs the whole document area rather than the side panel */
  full?: boolean;
  /** One of Paperwing's own (scanning: app.ts runs it) */
  paperwing?: PaperwingTool;
}

export type PaperwingTool = 'scan' | 'scan-ocr' | 'enhance-scan';

export interface ToolGroup {
  name: string;
  tools: AppTool[];
}

const C = {
  edit: '#d6336c',
  create: '#e5322d',
  export: '#12805c',
  organize: '#2d9d78',
  optimize: '#e34850',
  protect: '#7e4bf3',
  sign: '#a24cd8',
  review: '#e68619',
  ai: '#6b5bed',
};

/** Upstream category name -> Acrobat-style group name + colour */
const GROUPS: Record<string, { name: string; color: string }> = {
  'Edit & Annotate': { name: 'Edit', color: C.edit },
  'Convert to PDF': { name: 'Create a PDF', color: C.create },
  'Convert from PDF': { name: 'Export a PDF', color: C.export },
  'Organize & Manage': { name: 'Organize & manage', color: C.organize },
  'Optimize & Repair': { name: 'Optimize & repair', color: C.optimize },
  'Secure PDF': { name: 'Protect', color: C.protect },
};

/** Tools whose UI needs a full page canvas, not a narrow side panel */
const FULL = new Set([
  'edit-pdf',
  'edit-pdf-text',
  'pdf-multi-tool',
  'pdf-workflow',
  'form-creator',
  'form-filler',
  'compare-pdfs',
  'organize-pdf',
  'sign-pdf',
  'crop-pdf',
  'add-watermark',
  'bookmark',
  'add-stamps',
  'markdown-to-pdf',
  'header-footer',
  'pdf-layers',
  'overlay-pdf',
  'delete-pages',
  'extract-pages',
  'rotate-pdf',
  'digital-sign-pdf',
]);

const slug = (href: string) =>
  (href.split('/').pop() || '').replace(/\.html$/, '');

const byId = new Map<string, AppTool>();

export const groups: ToolGroup[] = categories
  .filter((c) => GROUPS[c.name])
  .map((c) => {
    const g = GROUPS[c.name];
    return {
      name: g.name,
      tools: c.tools.map((t) => {
        const id = slug(t.href);
        const tool: AppTool = byId.get(id) ?? {
          id,
          name: t.name,
          icon: t.icon.replace(/^ph-/, ''),
          color: g.color,
          desc: t.subtitle ?? '',
          href: t.href,
          full: FULL.has(id),
        };
        byId.set(id, tool);
        return tool;
      }),
    };
  });

const viewerTools: AppTool[] = [
  {
    id: 'comment',
    name: 'Add comments',
    icon: 'chat-centered-text',
    color: C.review,
    desc: 'Add sticky notes, highlights and drawings to the document.',
    action: 'comment',
  },
  {
    id: 'redact',
    name: 'Redact a PDF',
    icon: 'eraser',
    color: C.edit,
    desc: 'Permanently remove sensitive text and images.',
    action: 'redact',
  },
];
viewerTools.forEach((t) => byId.set(t.id, t));

// In the desktop app, Use a certificate signs inside the document, the way
// Acrobat does (src/acro/certs/), with the IDs installed on the computer;
// in a browser it stays BentoPDF's page (a certificate file)
const certificate = byId.get('digital-sign-pdf');
if (certificate && desktop?.certs) certificate.action = 'certificate';

export function getTool(id: string): AppTool | undefined {
  return byId.get(id);
}

/** Scanning (desktop app): Paperwing's own tools, not BentoPDF's pages */
let scanning = false;

/** Adds the scanning tools: Create a PDF ▸ Scanner (so also Convert ▸
 *  Create PDF from), Scan & OCR's start page, Enhance scanned pages */
export function enableScanning(): void {
  if (scanning) return;
  scanning = true;
  const scanner: AppTool = {
    id: 'scanner',
    name: 'Scanner',
    icon: 'scan',
    color: C.create,
    desc: 'Scan paper documents into a PDF, with a flatbed or document feeder.',
    paperwing: 'scan',
  };
  const scanOcr: AppTool = {
    id: 'scan-ocr',
    name: 'Scan & OCR',
    icon: byId.get('ocr-pdf')?.icon ?? 'scan',
    color: byId.get('ocr-pdf')?.color ?? C.optimize,
    desc: 'Scan a document or select a file to recognize text, or enhance scanned pages.',
    paperwing: 'scan-ocr',
  };
  const enhance: AppTool = {
    id: 'enhance-scan',
    name: 'Enhance scanned pages',
    icon: 'magic-wand',
    color: C.optimize,
    desc: 'Straighten, clean up and sharpen pages that were scanned.',
    paperwing: 'enhance-scan',
  };
  for (const t of [scanner, scanOcr, enhance]) byId.set(t.id, t);
  groups.find((g) => g.name === 'Create a PDF')?.tools.unshift(scanner);
  groups.find((g) => g.name === 'Optimize & repair')?.tools.push(enhance);
}

/** All tools ▸ Scan & OCR: the start page with scanning, else OCR alone */
const scanAndOcr = (): AppTool =>
  scanning
    ? byId.get('scan-ocr')!
    : alias(
        'ocr-pdf',
        'Scan & OCR',
        'Make scanned documents searchable and editable.'
      );

/** Override name/description to match Acrobat's wording */
function alias(id: string, name: string, desc?: string): AppTool {
  const t = byId.get(id)!;
  return { ...t, name, desc: desc ?? t.desc };
}

/** "All tools" list in the left panel (Acrobat's order) */
export const quickTools = (): AppTool[] => [
  alias(
    'pdf-to-word',
    'Export a PDF',
    'Convert PDFs to Word, Excel, images and more.'
  ),
  alias(
    'edit-pdf-text',
    'Edit a PDF',
    'Edit text and images right in your PDF.'
  ),
  alias(
    'image-to-pdf',
    'Create a PDF',
    'Create PDFs from images, Office files and more.'
  ),
  alias(
    'merge-pdf',
    'Combine files',
    'Merge multiple files into a single PDF.'
  ),
  alias(
    'pdf-multi-tool',
    'Organize pages',
    'Reorder, rotate, insert and delete pages.'
  ),
  byId.get('comment')!,
  scanAndOcr(),
  alias('protect-pdf', 'Protect a PDF', 'Add a password to restrict access.'),
  byId.get('redact')!,
  alias(
    'compress-pdf',
    'Compress a PDF',
    'Reduce file size while keeping quality.'
  ),
  alias('form-creator', 'Prepare a form', 'Create fillable form fields.'),
  alias('sign-pdf', 'Fill & Sign', 'Fill in forms and add your signature.'),
  // (desktop app: signing with installed Digital IDs, as in Acrobat)
  ...(desktop?.certs
    ? [
        alias(
          'digital-sign-pdf',
          'Use a certificate',
          'Sign with a Digital ID from your computer, a smart card or a file.'
        ),
      ]
    : []),
  alias(
    'compare-pdfs',
    'Compare files',
    'See the differences between two PDFs.'
  ),
];

/** Left panel lists for the Edit / Convert / E-Sign global tabs */
export const editTools = (): ToolGroup[] => [
  {
    name: 'Edit',
    tools: [
      alias('edit-pdf-text', 'Edit text & images'),
      byId.get('comment')!,
      byId.get('redact')!,
      alias('edit-pdf', 'Annotate & draw'),
      ...[
        'add-watermark',
        'header-footer',
        'page-numbers',
        'bates-numbering',
        'add-stamps',
        'crop-pdf',
        'bookmark',
        'table-of-contents',
        'background-color',
        'text-color',
        'remove-annotations',
        'edit-metadata',
      ].map((id) => byId.get(id)!),
    ],
  },
];

export const convertTools = (): ToolGroup[] => {
  const g = (name: string) => groups.find((x) => x.name === name)!;
  return [
    { name: 'Export PDF to', tools: g('Export a PDF').tools },
    { name: 'Create PDF from', tools: g('Create a PDF').tools },
  ];
};

export const signTools = (): ToolGroup[] => [
  {
    name: 'E-Sign',
    tools: [
      alias('sign-pdf', 'Fill & Sign'),
      alias('form-filler', 'Fill a form'),
      alias('digital-sign-pdf', 'Use a certificate'),
      alias('validate-signature-pdf', 'Validate signatures'),
      alias('timestamp-pdf', 'Add a timestamp'),
      alias('form-creator', 'Prepare a form'),
    ],
  },
];

/** Cards on the Home view */
export const recommendedTools = (): AppTool[] => [
  alias(
    'edit-pdf-text',
    'Edit a PDF',
    'Edit text and images in your document.'
  ),
  alias('merge-pdf', 'Combine files', 'Merge files into a single PDF.'),
  alias('compress-pdf', 'Compress a PDF', 'Make large PDFs smaller.'),
  alias('pdf-to-word', 'Export a PDF', 'Convert a PDF to Word.'),
];

/** Every tool, Acrobat's sections first: the order tool search ranks results in */
export const allToolGroups = (): ToolGroup[] => [
  {
    name: 'Edit',
    tools: [
      alias('edit-pdf-text', 'Edit a PDF'),
      alias('pdf-multi-tool', 'Organize pages'),
      byId.get('comment')!,
      alias('form-creator', 'Prepare a form'),
    ],
  },
  {
    name: 'Convert',
    tools: [
      alias('image-to-pdf', 'Create a PDF'),
      alias('pdf-to-word', 'Export a PDF'),
      alias('merge-pdf', 'Combine files'),
      scanAndOcr(),
      alias('compress-pdf', 'Compress a PDF'),
    ],
  },
  {
    name: 'E-Sign',
    tools: [
      alias('sign-pdf', 'Fill & Sign'),
      alias('digital-sign-pdf', 'Use a certificate'),
    ],
  },
  {
    name: 'Protect',
    tools: [
      alias('protect-pdf', 'Protect a PDF'),
      byId.get('redact')!,
      alias('compare-pdfs', 'Compare files'),
    ],
  },
  ...groups,
];

/** Pick a "create PDF" tool for a dropped non-PDF file */
export function toolForFile(file: File): AppTool | undefined {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = {
    jpg: 'jpg-to-pdf',
    jpeg: 'jpg-to-pdf',
    png: 'png-to-pdf',
    webp: 'webp-to-pdf',
    svg: 'svg-to-pdf',
    bmp: 'bmp-to-pdf',
    heic: 'heic-to-pdf',
    heif: 'heic-to-pdf',
    tif: 'tiff-to-pdf',
    tiff: 'tiff-to-pdf',
    txt: 'txt-to-pdf',
    md: 'markdown-to-pdf',
    json: 'json-to-pdf',
    csv: 'csv-to-pdf',
    rtf: 'rtf-to-pdf',
    odt: 'odt-to-pdf',
    doc: 'word-to-pdf',
    docx: 'word-to-pdf',
    xls: 'excel-to-pdf',
    xlsx: 'excel-to-pdf',
    ppt: 'powerpoint-to-pdf',
    pptx: 'powerpoint-to-pdf',
    epub: 'epub-to-pdf',
    xps: 'xps-to-pdf',
    eml: 'email-to-pdf',
    msg: 'email-to-pdf',
    xml: 'xml-to-pdf',
  };
  return map[ext] ? byId.get(map[ext]) : undefined;
}
