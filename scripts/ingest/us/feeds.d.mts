export function buildFeeds(input: {
  submissions?: Record<string, unknown>;
  documents?: Record<string, string>;
  finraDaily?: string | null;
  halts?: string | null;
  suspensions?: string | null;
  indexCsv?: Record<string, string>;
}): {
  submissions: { code: string; json: unknown }[];
  form4: { code: string; accession: string; acceptedAt: string; xml: string }[];
  schedule13: { code: string; accession: string; form: string; acceptedAt: string; xml: string }[];
  finraDaily: string | null;
  halts: string | null;
  suspensions: string | null;
  indexCsv: Record<string, string>;
};
