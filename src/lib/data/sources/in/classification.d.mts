export const SOURCE: "in_nse_classification";
export function parseClassification(
  text: string,
): { code: string; industry: string; name: string }[];
