// The search params of `/design`: the DataTable's own (`q`, `sort`, `page`, `size`, `f.department`) and
// `scenario`, which makes the sample source answer with no data or with a failure. The router validates
// them with this function (a bad link never breaks the page: what makes no sense is dropped), so the URL is
// the state of the demo table (FR-A-125).
import { DEPARTMENTS, type DepartmentId, type SampleScenario } from './sample-data';

export interface ShowcaseSearch {
  q?: string;
  sort?: string;
  page?: number;
  size?: number;
  scenario?: Exclude<SampleScenario, 'normal'>;
  'f.department'?: DepartmentId;
}

const SORTABLE = new Set(['name', 'email', 'department', 'role']);
const SIZES = new Set([10, 25, 50, 100]);

function positiveInteger(value: unknown): number | null {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,7}$/.test(text)) return null;
  const parsed = Number(text);
  return parsed >= 1 ? parsed : null;
}

export function validateShowcaseSearch(raw: Record<string, unknown>): ShowcaseSearch {
  const search: ShowcaseSearch = {};
  if (typeof raw.q === 'string' || typeof raw.q === 'number') search.q = String(raw.q);
  if (typeof raw.sort === 'string' && SORTABLE.has(raw.sort.replace(/^-/, ''))) {
    search.sort = raw.sort;
  }
  const page = positiveInteger(raw.page);
  if (page !== null) search.page = page;
  const size = positiveInteger(raw.size);
  if (size !== null && SIZES.has(size)) search.size = size;
  if (raw.scenario === 'empty' || raw.scenario === 'error') search.scenario = raw.scenario;
  const department = raw['f.department'];
  if (typeof department === 'string' && (DEPARTMENTS as readonly string[]).includes(department)) {
    search['f.department'] = department as DepartmentId;
  }
  return search;
}
