import type { Env } from './project-room';
import { route } from './routing';

export { ProjectRoom } from './project-room';

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return route(request, env, ctx, async () => new Response('not found', { status: 404 }));
	}
} satisfies ExportedHandler<Env>;
