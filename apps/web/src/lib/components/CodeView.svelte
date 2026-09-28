<script module lang="ts">
	// A static import here would still pull the WASM engine and all langs/themes into this
	// component's chunk, defeating the point — `getHighlighter` only calls `createHighlighter`
	// lazily, so the import has to be dynamic too, or bundlers ship it eagerly regardless.
	import type { Highlighter } from 'shiki/bundle/web';

	const LANGS = [
		'python',
		'typescript',
		'javascript',
		'svelte',
		'html',
		'css',
		'json',
		'markdown',
		'bash'
	] as const;

	const EXT_LANG: Record<string, (typeof LANGS)[number]> = {
		py: 'python',
		ts: 'typescript',
		tsx: 'typescript',
		js: 'javascript',
		mjs: 'javascript',
		jsx: 'javascript',
		svelte: 'svelte',
		html: 'html',
		htm: 'html',
		css: 'css',
		json: 'json',
		md: 'markdown',
		markdown: 'markdown',
		sh: 'bash',
		bash: 'bash'
	};

	function langFor(path: string): string {
		const ext = path.split('.').pop()?.toLowerCase() ?? '';
		return EXT_LANG[ext] ?? 'text';
	}

	let highlighterPromise: Promise<Highlighter> | null = null;
	function getHighlighter(): Promise<Highlighter> {
		highlighterPromise ??= import('shiki/bundle/web').then(({ createHighlighter }) =>
			createHighlighter({
				themes: ['github-light', 'github-dark'],
				langs: [...LANGS]
			})
		);
		return highlighterPromise;
	}
</script>

<script lang="ts">
	type File = { path: string; hash: string; content: string };
	let { file }: { file: File } = $props();

	let html = $state('');
	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		const current = file;
		getHighlighter().then((hl) => {
			if (current !== file) return; // a newer file/hash landed while we were awaiting
			html = hl.codeToHtml(current.content, {
				lang: langFor(current.path),
				themes: { light: 'github-light', dark: 'github-dark' },
				defaultColor: false
			});
		});
	});

	async function copy(): Promise<void> {
		await navigator.clipboard.writeText(file.content);
		copied = true;
		if (copyTimer) clearTimeout(copyTimer);
		copyTimer = setTimeout(() => (copied = false), 2000);
	}
</script>

<div class="flex h-full flex-col">
	<div
		class="flex items-center justify-between border-b border-hairline bg-gray-50 px-4 py-2 dark:border-gray-700 dark:bg-gray-800"
	>
		<span class="truncate font-mono text-sm text-gray-700 dark:text-gray-300">{file.path}</span>
		<button
			type="button"
			data-testid="copy"
			aria-label="Copy file contents"
			class="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:outline-none dark:focus-visible:ring-sky-500"
			class:text-gray-600={!copied}
			class:hover:bg-gray-200={!copied}
			class:dark:text-gray-300={!copied}
			class:dark:hover:bg-gray-700={!copied}
			class:text-green-700={copied}
			class:bg-green-100={copied}
			class:dark:text-green-300={copied}
			class:dark:bg-green-900={copied}
			onclick={copy}
		>
			{#if copied}
				<svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
					<path
						fill-rule="evenodd"
						d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z"
						clip-rule="evenodd"
					/>
				</svg>
				copied
			{:else}
				<svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
					<path
						d="M7 3a1 1 0 0 0-1 1v1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1h1a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1h-1V3a1 1 0 0 0-1-1H7Zm5 2H8v9h6V5h-2Zm2-1v1h-2V4h2ZM6 6h1v9a1 1 0 0 0 1 1h5v1H6V6Z"
					/>
				</svg>
				copy
			{/if}
		</button>
	</div>
	<div data-testid="code" class="code-lines flex-1 overflow-auto text-sm">
		<!-- `html` is Shiki's own HTML-escaped output for the file's content, not raw user input. -->
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		{@html html}
	</div>
</div>

<style>
	.code-lines :global(pre) {
		margin: 0;
		padding: 0.75rem 1rem;
		min-height: 100%;
	}

	.code-lines :global(code) {
		counter-reset: line;
		display: block;
	}

	.code-lines :global(.line) {
		counter-increment: line;
		display: inline-block;
		width: 100%;
		padding-left: 3.5ch;
		position: relative;
	}

	.code-lines :global(.line)::before {
		content: counter(line);
		position: absolute;
		left: 0;
		width: 3ch;
		text-align: right;
		color: #6b7280;
	}

	/* Empty lines have no text node, so the inline-block collapses to zero height
	   and its ::before line-number overlaps the next line. A filler char restores height. */
	.code-lines :global(.line):empty::after {
		content: '\200b';
	}

	/* Shiki dual themes (`defaultColor: false`): light applies by default, dark overrides
	   via the CSS vars Shiki emits per-token when the page's `.dark` class is set. */
	.code-lines :global(.shiki),
	.code-lines :global(.shiki span) {
		color: var(--shiki-light);
		background-color: var(--shiki-light-bg) !important;
	}

	:global(.dark) .code-lines :global(.shiki),
	:global(.dark) .code-lines :global(.shiki span) {
		color: var(--shiki-dark);
		background-color: var(--shiki-dark-bg) !important;
	}
</style>
