/**
 * Product names that carry a trailing acronym ("Client Context Bridge (CCB)")
 * read better when the acronym is a touch smaller than the full name: the name
 * stays the thing you scan for, the acronym is the aside it is.
 *
 * The split is deliberately narrow — only a parenthesized ALL-CAPS token at the
 * very end qualifies — so ordinary parentheses in a label ("~/.codex (default)")
 * are left exactly as they are.
 */

const TRAILING_ACRONYM = /^(.*\S)\s*\(([A-Z0-9][A-Z0-9-]{0,7})\)$/;

export interface DisplayNameParts {
  base: string;
  /** Parenthesized acronym without the parentheses, or null when absent. */
  acronym: string | null;
}

export function splitTrailingAcronym(name: string): DisplayNameParts {
  const match = TRAILING_ACRONYM.exec(name.trim());
  if (!match) return { base: name, acronym: null };
  return { base: match[1], acronym: match[2] };
}

/**
 * A name with its trailing acronym rendered one step smaller. Sized in `em`
 * so it follows whatever type scale the call site uses (rail row, page title,
 * plugin row) instead of pinning a px size.
 */
export function DisplayName({ name }: { name: string }) {
  const { base, acronym } = splitTrailingAcronym(name);
  if (!acronym) return <>{name}</>;
  return (
    <>
      {base} <span className="text-[0.82em]">({acronym})</span>
    </>
  );
}
