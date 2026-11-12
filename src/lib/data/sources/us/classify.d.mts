export function classifyItem(
  map: { version: string; rows: readonly unknown[] },
  item: {
    type?: string | null;
    item?: string | readonly string[] | null;
    form?: string | null;
    title?: string | null;
    facts?: {
      statementsParsed?: boolean;
      valueDisclosed?: boolean;
      counterpartyDisclosed?: boolean;
    };
  },
): { category: string; materiality: number; verifiable: boolean; mapVersion: string; rule: number };
