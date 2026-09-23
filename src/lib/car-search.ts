// Builds a Postgres tsquery string for the cars `search_vector` column.
//
// Each word becomes a prefix match, AND-ed together. Words that mix letters
// and digits also match their split form, because the inventory often stores
// e.g. model "LC" + trim "500" (indexed as 'lc', '500') while callers type
// "LC500". The unsplit form is kept so stock IDs like "B4595A" still match.
//
// Returns null when nothing searchable is left after sanitizing.

export function buildCarTsQuery(input: string): string | null {
  // Strip Postgres tsquery operators to prevent injection
  const words = input
    .replace(/[&|!<>():*\\'"]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);

  if (words.length === 0) return null;

  return words
    .map((w) => {
      const parts = /^[a-z0-9]+$/i.test(w) ? w.match(/[a-z]+|\d+/gi) ?? [] : [];
      if (parts.length < 2) return w + ":*";
      return `(${w}:* | (${parts.map((p) => p + ":*").join(" & ")}))`;
    })
    .join(" & ");
}
