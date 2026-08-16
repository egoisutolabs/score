// stream — the v1 SSE route: handshake, snapshots, filtered replay to
// score.stream.caught_up, then live follow (#82) until the client
// disconnects or is disconnected; follow=false closes at the boundary.
export * from "./route";
