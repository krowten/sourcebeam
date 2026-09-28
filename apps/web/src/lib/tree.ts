export type TreeNode = { name: string; path: string; children?: TreeNode[] };

/** Flat list of paths ("src/main.py") -> tree. Folders first, alphabetical within each level. */
export function buildTree(paths: string[]): TreeNode[] {
	const root: TreeNode[] = [];

	for (const path of paths) {
		const segments = path.split('/');
		let level = root;

		segments.forEach((name, i) => {
			const isFile = i === segments.length - 1;
			const nodePath = segments.slice(0, i + 1).join('/');
			let node = level.find((n) => n.name === name);
			if (!node) {
				node = isFile ? { name, path: nodePath } : { name, path: nodePath, children: [] };
				level.push(node);
			}
			if (!isFile) {
				node.children ??= [];
				level = node.children;
			}
		});
	}

	sortTree(root);
	return root;
}

/** The tree's first file, in the same order `buildTree` displays it (folders first). */
export function firstFile(nodes: TreeNode[]): string | null {
	for (const node of nodes) {
		if (node.children) {
			const found = firstFile(node.children);
			if (found) return found;
		} else {
			return node.path;
		}
	}
	return null;
}

/** Ancestor directories of a path (excluding the path itself). `'src/a/b.py'` -> `['src', 'src/a']`. */
export function ancestorsOf(path: string): string[] {
	const parts = path.split('/');
	const dirs: string[] = [];
	for (let i = 1; i < parts.length; i++) dirs.push(parts.slice(0, i).join('/'));
	return dirs;
}

/** Expanded tree folders: ancestors of the open file + manually opened, minus manually closed
 * ancestors. Non-ancestor entries in `userClosed` have no effect (only ancestors can be
 * collapsed — ontoggledir never puts anything else there, but the filter stays pure regardless). */
export function computeOpenDirs(
	openPath: string | null,
	userOpened: ReadonlySet<string>,
	userClosed: ReadonlySet<string>
): Set<string> {
	const ancestors = ancestorsOf(openPath ?? '');
	return new Set([...ancestors, ...userOpened].filter((d) => !userClosed.has(d)));
}

/** Encodes a file path for use as the URL segments after /:project/ — segment by segment, so
 * `/` stays a separator. Without this, a path containing `#`, `?` or `%` gets misread as URL
 * syntax the moment it's written to the address bar (replaceState in +page.svelte): `#` starts
 * a fragment, `?` starts a query string, and a bare `%` not followed by two hex digits is an
 * invalid escape — any of these truncates or corrupts the path a reload or shared link would
 * try to reopen. SvelteKit decodes the `[...file]` route param back to the original string, so
 * this only needs to be undone on the way out, not the way in. */
export function encodePathForUrl(path: string): string {
	return path.split('/').map(encodeURIComponent).join('/');
}

function sortTree(nodes: TreeNode[]): void {
	nodes.sort((a, b) => {
		const aIsDir = a.children !== undefined;
		const bIsDir = b.children !== undefined;
		if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
	for (const node of nodes) {
		if (node.children) sortTree(node.children);
	}
}
