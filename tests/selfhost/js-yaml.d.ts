// js-yaml is a dev dependency without bundled types; the drift test only needs `load`.
declare module "js-yaml" {
  export function load(text: string): unknown;
}
