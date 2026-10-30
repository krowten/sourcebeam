// A TCP proxy between the extension and the local Worker, so a test can cut the host's connection
// the way a network failure does (a reset, no close frame) and hold its reconnect attempts while
// it changes files on disk. Viewers keep connecting to the Worker directly.
import type { AddressInfo, Socket } from "node:net";

import { connect, createServer } from "node:net";

export type TestProxy = {
	url: string;
	/** Connections accepted so far, held ones included. */
	attempts: () => number;
	/** Resets every open connection on both sides. */
	drop: () => void;
	/** New connections are accepted but not forwarded until release(), so a handshake just waits. */
	hold: () => void;
	release: () => void;
	close: () => Promise<void>;
};

export async function startProxy(targetPort = 4173): Promise<TestProxy> {
	const sockets = new Set<Socket>();
	let held: (() => void)[] | null = null;
	let attempts = 0;
	const track = (socket: Socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => undefined);
	};
	const server = createServer((client) => {
		attempts++;
		track(client);
		const forward = () => {
			if (client.destroyed) return;
			const upstream = connect(targetPort, "127.0.0.1");
			track(upstream);
			client.pipe(upstream).pipe(client);
		};
		if (held) held.push(forward);
		else forward();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const drop = () => {
		for (const socket of sockets) socket.resetAndDestroy();
	};
	return {
		url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
		attempts: () => attempts,
		drop,
		hold: () => {
			held ??= [];
		},
		release: () => {
			const queue = held ?? [];
			held = null;
			for (const forward of queue) forward();
		},
		close: () => {
			drop();
			return new Promise((resolve) => server.close(() => resolve()));
		},
	};
}
