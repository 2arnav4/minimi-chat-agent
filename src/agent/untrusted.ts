/**
 * Helpers for text we place inside our own wrapper tags (<memory>, <result>).
 * That text comes from web pages or earlier messages, so it must not be able to
 * close the wrapper early (`</result>` then fake instructions) or break out of
 * an attribute. Escaping angle brackets keeps it readable for the model while
 * making every tag inside it inert.
 */
export const neutralizeTags = (s: string): string => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** For values inside a double-quoted attribute, e.g. url="...". */
export const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
