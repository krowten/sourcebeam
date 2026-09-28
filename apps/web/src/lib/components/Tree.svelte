<script lang="ts">
	import type { TreeNode } from '../tree';
	import Tree from './Tree.svelte';

	type Props = {
		nodes: TreeNode[];
		openPath: string | null;
		openDirs: Set<string>;
		onselect: (path: string) => void;
		ontoggledir: (path: string, open: boolean) => void;
	};
	let { nodes, openPath, openDirs, onselect, ontoggledir }: Props = $props();
</script>

<ul class="space-y-1 text-sm">
	{#each nodes as node (node.path)}
		<li>
			{#if node.children}
				<details
					open={openDirs.has(node.path)}
					ontoggle={(e) => ontoggledir(node.path, (e.currentTarget as HTMLDetailsElement).open)}
				>
					<summary
						class="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-gray-700 transition-colors select-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:outline-none dark:text-gray-300 dark:hover:bg-gray-800 dark:focus-visible:ring-sky-500 [&::-webkit-details-marker]:hidden"
					>
						<!-- chevron: right when collapsed, down when open. The state variants target this
						     folder's own <details> — Tailwind's group-open: would also fire for any open
						     ancestor folder, drawing a closed nested folder as open. -->
						<svg
							class="h-3 w-3 shrink-0 text-gray-400 transition-transform [details[open]>summary>&]:rotate-90"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2.5"
							aria-hidden="true"
						>
							<path stroke-linecap="round" stroke-linejoin="round" d="m9 5 7 7-7 7" />
						</svg>
						<!-- folder: closed / open — Heroicons micro (16/solid) folder, folder-open -->
						<svg
							class="h-4 w-4 shrink-0 text-amber-500/80 [details[open]>summary>&]:hidden"
							viewBox="0 0 16 16"
							fill="currentColor"
							aria-hidden="true"
						>
							<path
								d="M2 3.5A1.5 1.5 0 0 1 3.5 2h2.879a1.5 1.5 0 0 1 1.06.44l1.122 1.12A1.5 1.5 0 0 0 9.62 4H12.5A1.5 1.5 0 0 1 14 5.5v1.401a2.986 2.986 0 0 0-1.5-.401h-9c-.546 0-1.059.146-1.5.401V3.5ZM2 9.5v3A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5v-3A1.5 1.5 0 0 0 12.5 8h-9A1.5 1.5 0 0 0 2 9.5Z"
							/>
						</svg>
						<svg
							class="hidden h-4 w-4 shrink-0 text-amber-500/80 [details[open]>summary>&]:block"
							viewBox="0 0 16 16"
							fill="currentColor"
							aria-hidden="true"
						>
							<path
								d="M3 3.5A1.5 1.5 0 0 1 4.5 2h1.879a1.5 1.5 0 0 1 1.06.44l1.122 1.12A1.5 1.5 0 0 0 9.62 4H11.5A1.5 1.5 0 0 1 13 5.5v1H3v-3ZM3.081 8a1.5 1.5 0 0 0-1.423 1.974l1 3A1.5 1.5 0 0 0 4.081 14h7.838a1.5 1.5 0 0 0 1.423-1.026l1-3A1.5 1.5 0 0 0 12.919 8H3.081Z"
							/>
						</svg>
						<span class="truncate font-medium">{node.name}</span>
					</summary>
					<div class="mt-1 ml-3 border-l border-gray-200 pl-3 dark:border-gray-700/60">
						<Tree nodes={node.children} {openPath} {openDirs} {onselect} {ontoggledir} />
					</div>
				</details>
			{:else}
				<button
					type="button"
					data-testid="tree-item"
					data-path={node.path}
					class="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:outline-none dark:focus-visible:ring-sky-500"
					class:bg-sky-100={node.path === openPath}
					class:text-sky-900={node.path === openPath}
					class:font-medium={node.path === openPath}
					class:dark:bg-sky-900={node.path === openPath}
					class:dark:text-sky-100={node.path === openPath}
					class:text-gray-600={node.path !== openPath}
					class:dark:text-gray-400={node.path !== openPath}
					class:hover:bg-gray-100={node.path !== openPath}
					class:dark:hover:bg-gray-800={node.path !== openPath}
					onclick={() => onselect(node.path)}
				>
					<!-- file — Heroicons micro (16/solid) document-text -->
					<svg
						class="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500"
						viewBox="0 0 16 16"
						fill="currentColor"
						aria-hidden="true"
					>
						<path
							fill-rule="evenodd"
							d="M4 2a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5V6.621a1.5 1.5 0 0 0-.44-1.06L9.94 2.439A1.5 1.5 0 0 0 8.878 2H4Zm1 5.75A.75.75 0 0 1 5.75 7h4.5a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 5 7.75Zm0 3a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1-.75-.75Z"
							clip-rule="evenodd"
						/>
					</svg>
					<span class="truncate">{node.name}</span>
				</button>
			{/if}
		</li>
	{/each}
</ul>
