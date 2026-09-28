// Tiny ANSI helper for the deploy/project CLI summaries — no dependency, since `node:util`'s
// `styleText` only has the 16 named colors and we want the actual brand palette (the amber/blue
// from the logo). Respects NO_COLOR (https://no-color.org) and skips styling on a non-TTY stream
// (piped output, CI logs) so redirected output stays plain text.
const { NO_COLOR } = process.env;
const enabled = !NO_COLOR && process.stdout.isTTY;

function wrap(open: string, text: string, close = "39"): string {
	return enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text;
}

export const amber = (text: string) => wrap("38;2;251;191;36", text);
export const blue = (text: string) => wrap("38;2;2;132;199", text);
export const navy = (text: string) => wrap("38;2;56;103;130", text);
export const bold = (text: string) => wrap("1", text, "22");
export const dim = (text: string) => wrap("2", text, "22");

/** OSC 8 terminal hyperlink — clickable in iTerm2, Kitty, Windows Terminal, VS Code's integrated
 * terminal, gnome-terminal, etc. A terminal that doesn't support it just prints `text` plain,
 * same as the color codes above, so this never costs anything on an unsupported terminal. */
export const link = (text: string, url: string) => (enabled ? `\x1b]8;;${url}\x07${text}\x1b]8;;\x07` : text);
