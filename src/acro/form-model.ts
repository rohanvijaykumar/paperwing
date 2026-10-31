/**
 * The form of an open document, as PDFium holds it: its fields (grouped
 * from their widgets), what each one is set to, and what PDFium must be
 * told to set it to something else. The form layer (form-layer.ts) keeps
 * these up to date with the fields on the page, for the Form fields panel
 * (app.ts) and for PDFium's copy of the document.
 */
import type { FormValue, PageWidget } from './viewer';
import type { FieldMeta } from './forms';

export type FieldKind =
  | 'text'
  | 'checkbox'
  | 'radio'
  | 'dropdown'
  | 'list'
  | 'button'
  | 'signature';

/** A text field's text, whether a checkbox is ticked, or which radio button
 *  or option is chosen (-1: none) */
export type FieldState = string | boolean | number;

export interface LiveField {
  name: string;
  /** What to call it: its tooltip if it has one, else its name */
  label: string;
  kind: FieldKind;
  readOnly: boolean;
  required: boolean;
  multiline: boolean;
  password: boolean;
  comb: boolean;
  maxLength?: number;
  /** The size its text is drawn at (points); 0 sizes it to fit */
  fontSize: number;
  /** A dropdown's or list's options; a radio group's choices, one per
   *  widget (their names in the document, else "Option 1"…) */
  options: string[];
  /** Its widgets, in page order */
  widgets: PageWidget[];
  value: FieldState;
}

const KINDS: Record<number, FieldKind> = {
  1: 'button',
  2: 'checkbox',
  3: 'radio',
  4: 'dropdown',
  5: 'list',
  6: 'text',
  7: 'signature',
};

/** Field flags (/Ff) */
const FF = {
  readOnly: 1,
  required: 1 << 1,
  multiline: 1 << 12,
  password: 1 << 13,
  comb: 1 << 24,
};

/** Fields the user can change */
export const fillable = (f: LiveField) =>
  !f.readOnly && f.kind !== 'button' && f.kind !== 'signature';

/**
 * The fields of a document from its widgets (page by page, in each page's
 * order), with what pdf-lib read from the document added (`meta`, by field
 * name: labels, character limits, font sizes, radio choices).
 */
export function buildFields(
  pages: PageWidget[][],
  meta: ReadonlyMap<string, FieldMeta> = new Map()
): LiveField[] {
  const byName = new Map<string, LiveField>();
  for (const page of pages) {
    for (const w of page) {
      const kind = KINDS[w.field.type];
      if (!kind) continue;
      let f = byName.get(w.field.name);
      if (!f) {
        const m = meta.get(w.field.name);
        const flag = w.field.flag;
        f = {
          name: w.field.name,
          label: w.field.alternateName?.trim() || m?.label || w.field.name,
          kind,
          readOnly: (flag & FF.readOnly) !== 0,
          required: (flag & FF.required) !== 0,
          multiline: kind === 'text' && (flag & FF.multiline) !== 0,
          password: kind === 'text' && (flag & FF.password) !== 0,
          comb: kind === 'text' && (flag & FF.comb) !== 0,
          maxLength: m?.maxLength,
          fontSize: m?.fontSize ?? 0,
          options: [],
          widgets: [],
          value: '',
        };
        byName.set(f.name, f);
      }
      f.widgets.push(w);
    }
  }
  for (const f of byName.values()) {
    f.options = optionsOf(f, meta.get(f.name));
    f.value = stateOf(f);
  }
  return [...byName.values()];
}

function optionsOf(f: LiveField, m?: FieldMeta): string[] {
  if (f.kind === 'dropdown' || f.kind === 'list')
    return f.widgets[0]?.field.options.map((o) => o.label) ?? [];
  if (f.kind !== 'radio') return [];
  // Each radio button's name in the document (matched to its widget by
  // where it is), else its place
  return f.widgets.map((w, i) => {
    const near = m?.choices?.find(
      (c) =>
        c.page === w.pageIndex &&
        Math.abs(c.x - w.rect.origin.x) < 3 &&
        Math.abs(c.y - w.rect.origin.y) < 3
    );
    return near?.value || `Option ${i + 1}`;
  });
}

/** What a field is set to now, as its widgets show */
export function stateOf(f: Pick<LiveField, 'kind' | 'widgets'>): FieldState {
  const first = f.widgets[0]?.field;
  if (!first) return '';
  switch (f.kind) {
    case 'checkbox':
      return f.widgets.some((w) => !!w.field.isChecked);
    case 'radio':
      return f.widgets.findIndex((w) => !!w.field.isChecked);
    case 'dropdown':
    case 'list':
      return first.options.findIndex((o) => !!o.isSelected);
    default:
      return first.value ?? '';
  }
}

/** What PDFium must be told, widget by widget, to set `f` to `want`
 *  (nothing if it's set to that already, or can't be) */
export function stepsTo(
  f: LiveField,
  want: FieldState,
  /** Also a read-only field (its scripts work it out) */
  readOnlyToo = false
): { widget: PageWidget; value: FormValue }[] {
  const first = f.widgets[0];
  const settable = fillable(f) || (readOnlyToo && f.readOnly);
  if (!first || !settable || want === f.value) return [];
  switch (f.kind) {
    case 'text':
      return typeof want === 'string'
        ? [{ widget: first, value: { kind: 'text', text: want } }]
        : [];
    case 'checkbox':
      // Pressing it toggles it
      return typeof want === 'boolean'
        ? [{ widget: first, value: { kind: 'checked' } }]
        : [];
    case 'radio': {
      // A radio button can only be chosen (not unchosen) by pressing it
      const w = typeof want === 'number' ? f.widgets[want] : undefined;
      return w ? [{ widget: w, value: { kind: 'checked' } }] : [];
    }
    case 'dropdown':
    case 'list':
      // (an option can't be unchosen: PDFium would keep drawing it chosen)
      if (typeof want !== 'number' || want < 0 || want >= f.options.length)
        return [];
      return [
        {
          widget: first,
          value: { kind: 'selection', index: want, isSelected: true },
        },
      ];
    default:
      return [];
  }
}

/** The pages a field's widgets are on */
export const pagesOf = (f: LiveField) => [
  ...new Set(f.widgets.map((w) => w.pageIndex)),
];
