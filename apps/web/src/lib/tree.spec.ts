import { describe, it, expect } from 'vitest';
import { ancestorsOf, buildTree, computeOpenDirs, encodePathForUrl, firstFile } from './tree';

describe('buildTree', () => {
	it('returns empty array for empty input', () => {
		expect(buildTree([])).toEqual([]);
	});

	it('puts folders first, then files, each alphabetically', () => {
		const tree = buildTree(['zzz.py', 'src/main.py', 'aaa.py']);
		expect(tree.map((n) => n.name)).toEqual(['src', 'aaa.py', 'zzz.py']);
		expect(tree[0].children).toBeDefined();
		expect(tree[1].children).toBeUndefined();
	});

	it('builds nested folders and assigns full paths', () => {
		const tree = buildTree(['src/utils/format.py', 'src/main.py', 'README.md']);

		expect(tree).toEqual([
			{
				name: 'src',
				path: 'src',
				children: [
					{
						name: 'utils',
						path: 'src/utils',
						children: [{ name: 'format.py', path: 'src/utils/format.py' }]
					},
					{ name: 'main.py', path: 'src/main.py' }
				]
			},
			{ name: 'README.md', path: 'README.md' }
		]);
	});

	it('deduplicates a path listed twice', () => {
		const tree = buildTree(['a.py', 'a.py']);
		expect(tree).toEqual([{ name: 'a.py', path: 'a.py' }]);
	});

	it('merges siblings that share a deep directory prefix', () => {
		const tree = buildTree(['a/b/c/one.py', 'a/b/c/two.py']);
		expect(tree).toHaveLength(1);
		const c = tree[0].children![0].children![0];
		expect(c.path).toBe('a/b/c');
		expect(c.children!.map((n) => n.name)).toEqual(['one.py', 'two.py']);
	});

	it('keeps a file and a folder with the same name apart at the same level', () => {
		// 'build' the file comes first, then 'build/out.js' finds the same node and
		// grows children on it — documents that the node is reused, not duplicated.
		const tree = buildTree(['build', 'build/out.js']);
		expect(tree).toHaveLength(1);
		expect(tree[0].children).toEqual([{ name: 'out.js', path: 'build/out.js' }]);
	});

	it('sorts unicode names without dropping or duplicating entries', () => {
		// Absolute order of mixed scripts is locale-dependent (localeCompare), so only
		// assert the stable part: same-script relative order and no loss.
		const tree = buildTree(['яя.md', 'аа.md', 'zz.md', 'aa.md']);
		const names = tree.map((n) => n.name);
		expect(names).toHaveLength(4);
		expect(names.indexOf('аа.md')).toBeLessThan(names.indexOf('яя.md'));
		expect(names.indexOf('aa.md')).toBeLessThan(names.indexOf('zz.md'));
	});
});

describe('firstFile', () => {
	it('returns null for an empty tree', () => {
		expect(firstFile([])).toBeNull();
	});

	it('descends into the first folder before picking a top-level file', () => {
		// zzz.py sorts after README.md alphabetically, but the folder still wins.
		const tree = buildTree(['zzz/inner.py', 'README.md']);
		expect(firstFile(tree)).toBe('zzz/inner.py');
	});
});

describe('ancestorsOf', () => {
	it('lists nested directory ancestors, closest last', () => {
		expect(ancestorsOf('src/a/b.py')).toEqual(['src', 'src/a']);
	});

	it('returns empty array for a root-level file', () => {
		expect(ancestorsOf('README.md')).toEqual([]);
	});
});

describe('computeOpenDirs', () => {
	it('navigating to a file in another folder collapses the old ancestor', () => {
		// src/a/x.py was open (src, src/a expanded as ancestors), navigated to docs/y.py.
		const dirs = computeOpenDirs('docs/y.py', new Set(), new Set());
		expect(dirs).toEqual(new Set(['docs']));
		expect(dirs.has('src')).toBe(false);
		expect(dirs.has('src/a')).toBe(false);
	});

	it('manually collapsing an ancestor keeps it collapsed', () => {
		const dirs = computeOpenDirs('src/a/x.py', new Set(), new Set(['src/a']));
		expect(dirs).toEqual(new Set(['src']));
	});

	it('manually opening a non-ancestor folder keeps it open', () => {
		const dirs = computeOpenDirs('src/a/x.py', new Set(['other']), new Set());
		expect(dirs).toEqual(new Set(['src', 'src/a', 'other']));
	});

	it('null openPath leaves only the manually opened folders', () => {
		const dirs = computeOpenDirs(null, new Set(['docs']), new Set());
		expect(dirs).toEqual(new Set(['docs']));
	});

	it('a folder both opened and closed by the user ends up closed', () => {
		const dirs = computeOpenDirs(null, new Set(['docs']), new Set(['docs']));
		expect(dirs).toEqual(new Set());
	});

	it('closing a non-ancestor has no effect on ancestors', () => {
		const dirs = computeOpenDirs('src/a/x.py', new Set(), new Set(['unrelated']));
		expect(dirs).toEqual(new Set(['src', 'src/a']));
	});
});

describe('encodePathForUrl', () => {
	it('leaves an ordinary path untouched', () => {
		expect(encodePathForUrl('src/main.py')).toBe('src/main.py');
	});

	it('encodes #, ? and % so they cannot be misread as URL syntax', () => {
		expect(encodePathForUrl('notes#1.md')).toBe('notes%231.md');
		expect(encodePathForUrl('a?b.txt')).toBe('a%3Fb.txt');
		expect(encodePathForUrl('100%.txt')).toBe('100%25.txt');
	});

	it('keeps every "/" as a path separator, not an encoded segment boundary', () => {
		expect(encodePathForUrl('a/b#c/d.txt')).toBe('a/b%23c/d.txt');
	});

	it('round-trips through decodeURIComponent per segment', () => {
		const path = 'weird dir/file #1 (draft)?.md';
		const decoded = encodePathForUrl(path).split('/').map(decodeURIComponent).join('/');
		expect(decoded).toBe(path);
	});
});
