import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import {
  providerAuth,
  type SourceControlApiDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import { definition } from "../shared/definition.ts";
import * as ArcanumApi from "./ArcanumApi.ts";
import * as ArcanumPullRequestApi from "./ArcanumPullRequestApi.ts";
import * as ArcanumPullRequestProvider from "./ArcanumPullRequestProvider.ts";
import * as ArcanumSourceControlProvider from "./ArcanumSourceControlProvider.ts";

const makeDiscovery = Effect.gen(function* () {
  const api = yield* ArcanumApi.ArcanumApi;
  const cwd = yield* HostProcess.WorkingDirectory;
  return {
    type: "api",
    kind: definition.kind,
    label: definition.label,
    installHint: "Install Arc on the server and run `arc token store`, or set ARC_TOKEN.",
    probeAuth: api.viewer(cwd).pipe(
      Effect.map((account) =>
        providerAuth({ status: "authenticated", account, host: "a.yandex-team.ru" }),
      ),
      Effect.catch((error) =>
        Effect.succeed(
          providerAuth({
            status:
              error.reason === "unauthenticated" || error.reason === "missing-tool"
                ? "unauthenticated"
                : "unknown",
            host: "a.yandex-team.ru",
            detail:
              error.reason === "forbidden"
                ? "Arcanum denied access."
                : "Check Arc and the Arcanum credential on the server.",
          }),
        ),
      ),
    ),
  } satisfies SourceControlApiDiscoverySpec;
});
const services = ArcanumPullRequestApi.layer.pipe(Layer.provideMerge(ArcanumApi.layer));
const makeInstance = Effect.all({
  sourceControl: ArcanumSourceControlProvider.make,
  pullRequests: ArcanumPullRequestProvider.make,
  discovery: makeDiscovery,
});
export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
});
