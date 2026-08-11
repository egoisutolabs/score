#!/usr/bin/env bun
// Never prints a listening line, stays alive until the deadline kill reaches it.
console.log("booting, no listening line ever printed");
setInterval(() => {}, 60_000);
