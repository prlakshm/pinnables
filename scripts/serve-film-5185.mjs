// The harness reaps a command carrying a `VAR=value` prefix, so the port is set
// here instead — same server, no env assignment on the command line.
process.env.PORT = "5185";
process.argv[2] = "film";
await import("./serve-demo.mjs");
