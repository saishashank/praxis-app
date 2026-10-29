import type { Client } from "@libsql/client";
import type { Io } from "../pipeline/batch1-core.mjs";

export type InputsContext = {
  db: Client;
  market: string;
  d: string;
  io: Io;
  now: string;
  isTarget: boolean;
  universe: string[];
  inputs?: {
    index: ReturnType<typeof import("./indexBars.mjs").parseIndexText>;
    short: ReturnType<typeof import("../shortInterest.mjs").parseShortText>;
    actions?: import("../vendorActions/vendorActions.mjs").ParsedVendorActions;
  };
};
export type InputsHook = (ctx: InputsContext) => Promise<Record<string, unknown> | void>;
export const inputsStage: InputsHook;
