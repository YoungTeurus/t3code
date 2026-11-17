import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { definition } from "../shared/definition.ts";

import * as ArcanumApi from "./ArcanumApi.ts";
export { RequestSpacingMs } from "./ArcanumApi.ts";
import * as ArcanumCredentials from "./ArcanumCredentials.ts";
import * as ArcanumPullRequestProvider from "./ArcanumPullRequestProvider.ts";
import * as ArcanumSourceControlProvider from "./ArcanumSourceControlProvider.ts";

// Built once per server, so the verified-login memo is shared by every reader.
const services = ArcanumApi.layer.pipe(Layer.provideMerge(ArcanumCredentials.layer));

const makeInstance = Effect.all({
  sourceControl: ArcanumSourceControlProvider.make,
  discovery: ArcanumSourceControlProvider.makeDiscovery,
  pullRequests: ArcanumPullRequestProvider.make,
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
});
