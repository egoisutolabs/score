// [key] — one project's routes: actions (lifecycle verbs over the
// supervisor) and logs (stateless dated-log tail poll). Route modules all
// export GET/runtime/dynamic, so namespaces keep them unambiguous.
export * as actions from "./actions";
export * as logs from "./logs";
