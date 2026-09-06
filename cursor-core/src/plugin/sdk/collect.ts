import { __descriptor, __getRegisteredPlugin } from "cursor-byok:plugin";

if (Deno.args.length !== 1) throw new Error("plugin entry URL is required");
await import(Deno.args[0]);
console.log("CURSOR_BYOK_PLUGIN_DEFINITION:" + JSON.stringify(__descriptor(__getRegisteredPlugin())));
