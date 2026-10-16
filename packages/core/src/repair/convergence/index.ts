/**
 * Convergence: the deterministic rules that decide a repair loop should stop
 * and hand the PR to a human (analysis §2.3), and the port a model-backed
 * classifier would answer through. Reads the ledger's waves and findings;
 * never pings, labels, or comments — repair acts on the verdict.
 */

export * from "./convergence.policy";
export * from "./finding-classifier.interface";
