<script lang="ts">
	import favicon from '../lib/assets/favicon.svg';
</script>

<svelte:head>
	<title>sourcebeam — live, read-only code sharing</title>
	<meta
		name="description"
		content="Share code live from VS Code or JetBrains in a read-only browser viewer. No screen sharing, no write access, self-hosted on Cloudflare Workers."
	/>
</svelte:head>

<div
	class="flex min-h-screen flex-col items-center justify-center gap-6 bg-white px-6 text-center text-ink dark:bg-gray-900 dark:text-gray-100"
>
	<div class="flex items-center gap-4">
		<img src={favicon} class="h-16 w-16" alt="" />
		<h1 class="font-display text-4xl font-bold tracking-tight">
			<span class="text-sky-600 dark:text-sky-500">source</span><span
				class="text-amber-500 dark:text-amber-400">beam</span
			>
		</h1>
	</div>
	<p class="max-w-md text-gray-600 dark:text-gray-400">
		A live, read-only mirror of a project folder. The host writes code in their editor; you watch it
		change here, in real time.
	</p>
	<p class="max-w-md text-sm text-gray-500 dark:text-gray-500">
		There's nothing to browse from this page — viewing a project requires an invite link from its
		host, which opens <span class="font-mono">/&lbrace;project&rbrace;</span> with a signed token.
	</p>
	<a
		href="https://github.com/krowten/sourcebeam"
		class="text-sm font-medium text-gray-600 underline decoration-hairline underline-offset-4 hover:text-sky-600 dark:text-gray-400 dark:hover:text-sky-500"
	>
		github.com/krowten/sourcebeam
	</a>
</div>
