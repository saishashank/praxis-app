export declare const STAGE_TABLES: readonly string[];
export declare function stageTablesFor(
  profile:
    | {
        readonly haltModel?: string | null;
        readonly fields?: Readonly<Record<string, { readonly value?: unknown }>>;
      }
    | null
    | undefined,
): string[];
