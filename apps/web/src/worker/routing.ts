// Pure routing logic shared by the real worker entry (worker.ts, falls back to SvelteKit)
// and the test entry (test-entry.ts, falls back to a plain 404) — see both for wiring.

type RouteEnv = { PROJECT_ROOM: DurableObjectNamespace };

export async function route<E extends RouteEnv>(
	request: Request,
	env: E,
	ctx: ExecutionContext,
	fallback: (request: Request, env: E, ctx: ExecutionContext) => Response | Promise<Response>
): Promise<Response> {
	const url = new URL(request.url);

	// Forwarded whether or not this is a real Upgrade request: a plain GET/HEAD here is the
	// viewer's auth probe (see live-client.svelte.ts's probeThenDecide) — the DO itself
	// resolves authorization before deciding whether to upgrade, so it can answer a probe
	// with a definitive 403/204 instead of the page shell's context-free 200 (ssr is off for
	// the project page, so it never checks the invite at all).
	const wsM = url.pathname.match(/^\/ws\/([a-z0-9][a-z0-9_-]{0,63})$/);
	if (wsM) {
		const doReq = new Request(`https://do/?project=${wsM[1]}`, request);
		return env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(wsM[1])).fetch(doReq);
	}

	// exchange ?token= for a viewer cookie on the project page
	const pageM = url.pathname.match(/^\/([a-z0-9][a-z0-9_-]{0,63})(\/.*)?$/);
	const token = url.searchParams.get('token');
	if (pageM && token) {
		const project = pageM[1];
		const stub = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(project));
		const res = await stub.fetch(
			`https://do/verify?project=${project}&token=${encodeURIComponent(token)}`
		);
		const clean = new URL(url);
		clean.searchParams.delete('token');
		const headers = new Headers({ Location: clean.pathname + clean.search });
		if (res.status === 200) {
			const session = (await res.json()) as { token: string; maxAge: number };
			headers.append(
				'Set-Cookie',
				`sb_view_${project}=${session.token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${session.maxAge}`
			);
		}
		return new Response(null, { status: 302, headers });
	}

	return fallback(request, env, ctx);
}
