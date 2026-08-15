/**
 * Test fixtures for the daemon feature: the D1 wedge-repo builders, the
 * proven stray-commit evidence, the real-subprocess runner they need, and
 * the shared loop-test harness (fake runner, capture logger, managed home,
 * canned gh/git/tmux responses). Test support only — production code never
 * imports from here.
 */
export * from "./harness.fixture";
export * from "./wedge.fixture";
