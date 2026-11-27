/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as artifactPage from "../artifactPage.js";
import type * as artifacts from "../artifacts.js";
import type * as boxHooks from "../boxHooks.js";
import type * as boxImage from "../boxImage.js";
import type * as boxMachine from "../boxMachine.js";
import type * as boxProviders_fly from "../boxProviders/fly.js";
import type * as boxProviders_types from "../boxProviders/types.js";
import type * as boxService from "../boxService.js";
import type * as boxStates from "../boxStates.js";
import type * as boxes from "../boxes.js";
import type * as clearMachine from "../clearMachine.js";
import type * as clearStates from "../clearStates.js";
import type * as commandMachine from "../commandMachine.js";
import type * as commandStates from "../commandStates.js";
import type * as crons from "../crons.js";
import type * as devices from "../devices.js";
import type * as http from "../http.js";
import type * as lib from "../lib.js";
import type * as machines from "../machines.js";
import type * as memorySync from "../memorySync.js";
import type * as migrations from "../migrations.js";
import type * as moveMachine from "../moveMachine.js";
import type * as moveStates from "../moveStates.js";
import type * as moves from "../moves.js";
import type * as requestMachine from "../requestMachine.js";
import type * as requestStates from "../requestStates.js";
import type * as phone from "../phone.js";
import type * as projectHeads from "../projectHeads.js";
import type * as projectNotes from "../projectNotes.js";
import type * as push from "../push.js";
import type * as pushHealth from "../pushHealth.js";
import type * as pushSeal from "../pushSeal.js";
import type * as pushTargets from "../pushTargets.js";
import type * as pushText from "../pushText.js";
import type * as redaction from "../redaction.js";
import type * as relay from "../relay.js";
import type * as runnerAccess from "../runnerAccess.js";
import type * as share from "../share.js";
import type * as shareCard from "../shareCard.js";
import type * as shareRekey from "../shareRekey.js";
import type * as sync from "../sync.js";
import type * as tokens from "../tokens.js";
import type * as uploads from "../uploads.js";
import type * as version from "../version.js";
import type * as viewer from "../viewer.js";
import type * as wakes from "../wakes.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  artifactPage: typeof artifactPage;
  artifacts: typeof artifacts;
  boxHooks: typeof boxHooks;
  boxImage: typeof boxImage;
  boxMachine: typeof boxMachine;
  "boxProviders/fly": typeof boxProviders_fly;
  "boxProviders/types": typeof boxProviders_types;
  boxService: typeof boxService;
  boxStates: typeof boxStates;
  boxes: typeof boxes;
  clearMachine: typeof clearMachine;
  clearStates: typeof clearStates;
  commandMachine: typeof commandMachine;
  commandStates: typeof commandStates;
  crons: typeof crons;
  devices: typeof devices;
  http: typeof http;
  lib: typeof lib;
  machines: typeof machines;
  memorySync: typeof memorySync;
  migrations: typeof migrations;
  moveMachine: typeof moveMachine;
  moveStates: typeof moveStates;
  moves: typeof moves;
  requestMachine: typeof requestMachine;
  requestStates: typeof requestStates;
  phone: typeof phone;
  projectHeads: typeof projectHeads;
  projectNotes: typeof projectNotes;
  push: typeof push;
  pushHealth: typeof pushHealth;
  pushSeal: typeof pushSeal;
  pushTargets: typeof pushTargets;
  pushText: typeof pushText;
  redaction: typeof redaction;
  relay: typeof relay;
  runnerAccess: typeof runnerAccess;
  share: typeof share;
  shareCard: typeof shareCard;
  shareRekey: typeof shareRekey;
  sync: typeof sync;
  tokens: typeof tokens;
  uploads: typeof uploads;
  version: typeof version;
  viewer: typeof viewer;
  wakes: typeof wakes;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  staticHosting: import("@convex-dev/static-hosting/_generated/component.js").ComponentApi<"staticHosting">;
  stateMachines: import("@convex-dev/state-machines/_generated/component.js").ComponentApi<"stateMachines">;
};
