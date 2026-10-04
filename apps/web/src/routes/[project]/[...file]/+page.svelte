<script lang="ts">
	import { onDestroy } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import favicon from '../../../lib/assets/favicon.svg';
	import { createLiveClient } from '../../../lib/live-client.svelte';
	import {
		ancestorsOf,
		buildTree,
		computeOpenDirs,
		encodePathForUrl,
		firstFile
	} from '../../../lib/tree';
	import Tree from '../../../lib/components/Tree.svelte';
	import CodeView from '../../../lib/components/CodeView.svelte';

	// `project` is a required route segment for this page, always present.
	const projectId = page.params.project as string;
	const initialFile = page.params.file || null;

	const client = createLiveClient(projectId);
	onDestroy(() => client.close());

	let openedInitial = false;
	// Two intent sets (not derived from one another — otherwise a user click can't be told
	// apart from a programmatic ancestor open during navigation):
	const userOpened = new SvelteSet<string>(); // non-ancestors, manually expanded
	const userClosed = new SvelteSet<string>(); // ancestors, manually collapsed

	const tree = $derived(buildTree(client.paths));
	const openDirs = $derived(computeOpenDirs(client.openPath, userOpened, userClosed));

	// Opening a file always expands the path to it: clear "manually collapsed" on its current ancestors.
	$effect(() => {
		for (const dir of ancestorsOf(client.openPath ?? '')) userClosed.delete(dir);
	});

	function toggleDir(path: string, open: boolean): void {
		const isAncestor = ancestorsOf(client.openPath ?? '').includes(path);
		if (open) {
			userClosed.delete(path);
			if (!isAncestor) userOpened.add(path); // a programmatic ancestor open never writes here
		} else {
			userOpened.delete(path);
			if (isAncestor) userClosed.add(path);
		}
	}

	// Once access is gone for good the socket state is beside the point: say so instead of
	// showing a "reconnecting…" that will never succeed.
	const ended = $derived(client.projectDeleted || client.inviteInvalid);
	const statusLabel = $derived(
		client.projectDeleted
			? 'deleted'
			: client.inviteInvalid
				? 'no access'
				: client.status === 'live'
					? 'live'
					: client.status === 'reconnecting'
						? 'reconnecting…'
						: 'connecting…'
	);
	const live = $derived(!ended && client.status === 'live');
	const waiting = $derived(!ended && client.status !== 'live');

	$effect(() => {
		if (openedInitial || client.paths.length === 0) return;
		const target =
			initialFile && client.paths.includes(initialFile) ? initialFile : firstFile(tree);
		if (!target) return;
		openedInitial = true;
		client.open(target);
	});

	$effect(() => {
		if (!client.openPath) return;
		const url = resolve('/[project]/[...file]', {
			project: projectId,
			file: encodePathForUrl(client.openPath)
		});
		if (page.url.pathname !== url) replaceState(url, {});
	});

	function toggleTheme(): void {
		const dark = document.documentElement.classList.toggle('dark');
		document.cookie = `theme=${dark ? 'dark' : 'light'};path=/;max-age=31536000;SameSite=Lax`;
	}
</script>

<div class="flex h-screen flex-col bg-white text-ink dark:bg-gray-900 dark:text-gray-100">
	<header
		class="flex items-center justify-between border-b border-hairline bg-gray-50 px-4 py-2.5 dark:border-gray-700 dark:bg-gray-800"
	>
		<div class="flex items-center gap-3">
			<a href={resolve('/')} class="flex items-center gap-2">
				<img src={favicon} class="h-9 w-9" alt="" />
				<span class="font-display text-xl font-bold tracking-tight">
					<span class="text-sky-600 dark:text-sky-500">source</span><span
						class="text-amber-500 dark:text-amber-400">beam</span
					>
				</span>
			</a>
			<div class="flex items-center gap-3 pt-1">
				<span class="h-6 w-px bg-hairline dark:bg-gray-600"></span>
				<span class="font-mono text-sm text-gray-600 dark:text-gray-400">{projectId}</span>
			</div>
		</div>
		<div class="flex items-center gap-3">
			<span
				data-testid="status"
				class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium"
				class:bg-green-100={live}
				class:text-green-800={live}
				class:dark:bg-green-900={live}
				class:dark:text-green-300={live}
				class:bg-yellow-100={waiting}
				class:text-yellow-800={waiting}
				class:dark:bg-yellow-900={waiting}
				class:dark:text-yellow-300={waiting}
				class:bg-gray-100={ended}
				class:text-gray-600={ended}
				class:dark:bg-gray-700={ended}
				class:dark:text-gray-300={ended}
			>
				<span
					class="h-1.5 w-1.5 rounded-full"
					class:bg-green-500={live}
					class:bg-yellow-500={waiting}
					class:bg-gray-400={ended}
				></span>
				{statusLabel}
			</span>
			<button
				type="button"
				data-testid="theme-toggle"
				aria-label="Toggle theme"
				class="rounded-lg p-2 text-gray-500 hover:bg-gray-200 focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:outline-none dark:text-gray-400 dark:hover:bg-gray-700 dark:focus-visible:ring-gray-500"
				onclick={toggleTheme}
			>
				<!-- sun (shown in dark mode) -->
				<svg
					class="hidden h-5 w-5 dark:block"
					viewBox="0 0 20 20"
					fill="currentColor"
					aria-hidden="true"
				>
					<path
						d="M10 2a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 10 2ZM10 15a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 10 15ZM10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM15.657 5.404a.75.75 0 1 0-1.06-1.06l-1.061 1.06a.75.75 0 0 0 1.06 1.06l1.06-1.06ZM6.464 14.596a.75.75 0 1 0-1.06-1.06l-1.06 1.06a.75.75 0 0 0 1.06 1.06l1.06-1.06ZM18 10a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 18 10ZM5 10a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 5 10ZM14.596 15.657a.75.75 0 0 0 1.06-1.06l-1.06-1.061a.75.75 0 1 0-1.06 1.06l1.06 1.06ZM5.404 6.464a.75.75 0 0 0 1.06-1.06l-1.06-1.06a.75.75 0 1 0-1.061 1.06l1.06 1.06Z"
					/>
				</svg>
				<!-- moon (shown in light mode) -->
				<svg class="h-5 w-5 dark:hidden" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
					<path
						fill-rule="evenodd"
						d="M7.455 2.004a.75.75 0 0 1 .26.77 7 7 0 0 0 9.958 7.967.75.75 0 0 1 1.067.853A8.5 8.5 0 1 1 6.647 1.921a.75.75 0 0 1 .808.083Z"
						clip-rule="evenodd"
					/>
				</svg>
			</button>
		</div>
	</header>

	{#if client.projectDeleted}
		<div
			data-testid="project-deleted"
			class="flex flex-1 items-center justify-center text-gray-500 dark:text-gray-400"
		>
			Project deleted
		</div>
	{:else if client.inviteInvalid}
		<div
			data-testid="invite-invalid"
			class="flex flex-1 items-center justify-center text-gray-500 dark:text-gray-400"
		>
			No access — the invite link has expired or the host revoked access. Ask the host for a new
			link.
		</div>
	{:else if client.treeReceived && client.paths.length === 0}
		<div
			data-testid="empty-project"
			class="flex flex-1 items-center justify-center text-gray-500 dark:text-gray-400"
		>
			Project is empty — the host hasn't started broadcasting yet
		</div>
	{:else}
		<div class="flex flex-1 overflow-hidden">
			<nav
				class="w-64 shrink-0 overflow-auto border-r border-hairline bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800"
			>
				<Tree
					nodes={tree}
					openPath={client.openPath}
					{openDirs}
					onselect={(path) => client.open(path)}
					ontoggledir={toggleDir}
				/>
			</nav>
			<main class="flex-1 overflow-hidden">
				{#if client.deleted}
					<div
						data-testid="file-deleted"
						class="flex h-full items-center justify-center text-gray-500 dark:text-gray-400"
					>
						File deleted
					</div>
				{:else if client.file}
					<CodeView file={client.file} />
				{/if}
			</main>
		</div>
	{/if}
</div>
