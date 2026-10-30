import { useEffect, useState } from "react";
import { create } from "zustand";
import type { EnvironmentId, ThreadId, ThreadSnoozeDependency } from "@t3tools/contracts";
import { useProjects, useThreadShells } from "../state/entities";
import { useThreadSearch } from "../state/queries";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "./ui/dialog";

type Choice = {
  readonly targetThreadId: ThreadId;
  readonly until: "settled" | "completed";
  readonly expectedDependencyId?: string;
};
type Request = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly dependency: ThreadSnoozeDependency | null;
  readonly resolve: (choice: Choice | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

export function requestSnoozeUntilThread(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  dependency: ThreadSnoozeDependency | null = null,
): Promise<Choice | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) =>
    useRequest.setState({ request: { environmentId, threadId, dependency, resolve } }),
  );
}

function finish(choice: Choice | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(choice);
}

export function SnoozeUntilThreadDialogHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves a pending selection when the host unmounts
  useEffect(() => () => finish(null), []);
  return request ? <Picker request={request} /> : null;
}

function Picker({ request }: { readonly request: Request }) {
  const [query, setQuery] = useState("");
  const [includeSettled, setIncludeSettled] = useState(false);
  const [selected, setSelected] = useState<ThreadId | null>(null);
  const [until, setUntil] = useState<Choice["until"]>("settled");
  const threads = useThreadShells();
  const projects = useProjects();
  useThreadSearch([request.environmentId], query, { titlesOnly: true });
  const names = new Map(
    projects.filter((p) => p.environmentId === request.environmentId).map((p) => [p.id, p.title]),
  );
  const candidates = threads
    .filter(
      (thread) =>
        thread.environmentId === request.environmentId &&
        thread.id !== request.threadId &&
        thread.deletedAt === null &&
        thread.archivedAt === null &&
        (includeSettled || (thread.settledOverride !== "settled" && thread.settledAt == null)) &&
        `${thread.title} ${names.get(thread.projectId) ?? ""}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()),
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const target = threads.find(
    (thread) => thread.environmentId === request.environmentId && thread.id === selected,
  );
  const invalid =
    target == null ||
    (until === "settled" && (target.settledOverride === "settled" || target.settledAt != null));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Snooze until another thread</DialogTitle>
          <DialogDescription>
            Choose a thread on this environment and the event to wait for.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            aria-label="Search threads"
            placeholder="Search threads or projects"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <label>
            <input
              type="checkbox"
              checked={includeSettled}
              onChange={(event) => setIncludeSettled(event.target.checked)}
            />{" "}
            Include settled threads
          </label>
          <div className="max-h-64 overflow-y-auto">
            {candidates.map((thread) => (
              <button
                key={thread.id}
                type="button"
                className="block w-full p-2 text-left"
                aria-pressed={selected === thread.id}
                onClick={() => setSelected(thread.id)}
              >
                {thread.title} · {names.get(thread.projectId) ?? ""}
                {thread.settledOverride === "settled" || thread.settledAt != null
                  ? " · Settled"
                  : ""}
              </button>
            ))}
          </div>
          <label>
            <input
              type="radio"
              checked={until === "settled"}
              onChange={() => setUntil("settled")}
            />{" "}
            Settled
          </label>
          <label>
            <input
              type="radio"
              checked={until === "completed"}
              onChange={() => setUntil("completed")}
            />{" "}
            Successful run
          </label>
          {target != null &&
          (target.settledOverride === "settled" || target.settledAt != null) &&
          until === "settled" ? (
            <p>This thread is already settled. Choose another thread or event.</p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            disabled={invalid}
            onClick={() => {
              if (selected !== null)
                finish({
                  targetThreadId: selected,
                  until,
                  ...(request.dependency?.targetThreadId === selected &&
                  request.dependency.until === until
                    ? { expectedDependencyId: request.dependency.dependencyId }
                    : {}),
                });
            }}
          >
            Snooze
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
