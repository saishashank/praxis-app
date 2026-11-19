export const CATEGORY_KIND: string;
export const CATEGORY_MAP: {
  readonly version: string;
  readonly rows: readonly {
    readonly match: {
      readonly type?: string;
      readonly item?: string;
      readonly form?: string;
      readonly title_re?: string;
    };
    readonly category: string;
    readonly materiality: 0 | 1 | 2 | 3;
    readonly verifiable: boolean;
    readonly materiality_disclosed?: 0 | 1 | 2 | 3;
  }[];
};
