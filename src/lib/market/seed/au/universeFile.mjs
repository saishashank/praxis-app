// The header row of the ASX listed-companies CSV (M19 B2, D-1003 e): the file format of the AU universe import,
// moved out of src/lib/data/universe/parse.mjs so the classification word lives in the seed folder only.
// Lower-case, compared after trimming and case folding by the parser.
export const AU_UNIVERSE_HEADER = Object.freeze([
  "company name",
  "asx code",
  "gics industry group",
]);
