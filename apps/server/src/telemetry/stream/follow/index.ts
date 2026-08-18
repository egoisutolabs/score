// follow — the stream's live half (#82): shared per-project tailers
// (watch-plus-poll wake loops) and the per-subscription follow engine —
// heartbeats, the bounded outbound queue, cursor advancement, and the
// deletion/overflow close boundaries. Refuses to replay history (the
// stream folder's job) and never mutates any store.
export * from "./follow.service";
export * from "./tailer.service";
