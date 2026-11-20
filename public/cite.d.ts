export function linkCitations(html: string, link: (n: number) => string | null): string;
export function citedNumbers(markdown: string): Set<number>;
export function safeHref(href: string, base?: string): string | null;
export function esc(s: unknown): string;
export function answerRenderer(base?: string): Record<string, (...args: any[]) => string>;
export function citationHtml(n: number, sources: { n: number; url: string; title?: string }[] | null, base?: string): string | null;
export function waitingLabel(idleMs: number): string | null;
