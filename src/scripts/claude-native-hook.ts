export * from "./codebuddy-native-hook.js";

import { runCodexNativeHookCli } from "./codebuddy-native-hook.js";

if (import.meta.url === `file://${process.argv[1]}`) {
  runCodexNativeHookCli().catch((error) => {
    process.stderr.write(
      `[omb] claude-native-hook failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
