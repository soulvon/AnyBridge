import { defineProviderPlugin } from "cursor-byok:plugin";
import { codexDeviceOAuth } from "./oauth.ts";
import { codexProvider } from "./provider.ts";
import {
  consumeResetCardAction,
  credentialImport,
  listResetCardsAction,
  presentAccount,
  refreshAccount,
  RESOURCE_TYPE,
} from "./resources.ts";

export default defineProviderPlugin({
  providers: [codexProvider],
  resources: [{
    type: RESOURCE_TYPE,
    displayName: { "en-US": "ChatGPT accounts", "zh-CN": "ChatGPT 账号" },
    add: [codexDeviceOAuth],
    import: credentialImport,
    present: presentAccount,
    actions: [listResetCardsAction, consumeResetCardAction],
    refresh: refreshAccount,
  }],
});
