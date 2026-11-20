/**
 * Helpers for text we place inside our own wrapper tags (<memory>, <result>).
 * That text comes from web pages or earlier messages, so it must not be able to
 * close the wrapper early (`</result>` then fake instructions) or break out of
 * an attribute. Escaping angle brackets keeps it readable for the model while
 * making every tag inside it inert.
 */
// '&' is escaped first: otherwise a page containing the literal text "&lt;/result&gt;" would look
// exactly like a real tag we escaped, and the two could not be told apart.
export const neutralizeTags = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** For values inside a double-quoted attribute, e.g. url="...". */
export const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Removes citation markers like [3], [3, 7] or [2][5] from earlier answers before they are
 * shown to the model again (memory excerpts, recent turns). Those numbers pointed at search
 * results from an old turn; left in, the model copies them and cites results it never got.
 * "[2](url)" is a markdown link label, not a citation, so it is kept.
 */
export const stripCitations = (s: string): string => s.replace(/ ?\[\d{1,3}(?:\s*,\s*\d{1,3})*\](?!\()/g, '');
