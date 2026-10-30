import { useEffect, useId, useState } from "react";
import { CheckIcon, SearchIcon } from "lucide-react";
import { create } from "zustand";
import type { EnvironmentId, ThreadId, ThreadSnoozeDependency } from "@t3tools/contracts";
import { cn } from "../lib/utils";
import { useProjects, useThreadShells } from "../state/entities";
import { useThreadSearch } from "../state/queries";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import { Spinner } from "./ui/spinner";
import { Switch } from "./ui/switch";
import { Toggle, ToggleGroup } from "./ui/toggle-group";
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

function isSettled(thread: ReturnType<typeof useThreadShells>[number]) {
  return thread.settledOverride === "settled" || thread.settledAt != null;
}

function Picker({ request }: { readonly request: Request }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [includeSettled, setIncludeSettled] = useState(false);
  const [selected, setSelected] = useState<ThreadId | null>(null);
  const [until, setUntil] = useState<Choice["until"]>("settled");
  const threads = useThreadShells();
  const projects = useProjects();
  const search = useThreadSearch([request.environmentId], query, { titlesOnly: true });
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
        (includeSettled || !isSettled(thread)) &&
        `${thread.title} ${names.get(thread.projectId) ?? ""}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()),
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const target = threads.find(
    (thread) => thread.environmentId === request.environmentId && thread.id === selected,
  );
  const invalid = target == null || (until === "settled" && isSettled(target));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Snooze until another thread</DialogTitle>
          <DialogDescription>
            Choose a thread on this environment and the event to wait for.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <InputGroup>
            <InputGroupAddon>
              {search.isPending ? <Spinner aria-hidden /> : <SearchIcon aria-hidden />}
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search threads"
              autoFocus
              placeholder="Search threads or projects"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </InputGroup>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <span id={`${id}-threads`} className="text-xs font-medium text-muted-foreground">
                Thread
              </span>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                Include settled threads
                <Switch size="sm" checked={includeSettled} onCheckedChange={setIncludeSettled} />
              </label>
            </div>
            <div
              role="group"
              aria-labelledby={`${id}-threads`}
              className="flex max-h-64 flex-col divide-y divide-border/60 overflow-y-auto rounded-lg border border-border/70 bg-background"
            >
              {candidates.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {query.trim() ? "No matching threads." : "No other threads to wait for."}
                </p>
              ) : (
                candidates.map((thread) => {
                  const isSelected = selected === thread.id;
                  return (
                    <button
                      key={thread.id}
                      type="button"
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:bg-primary/8"
                      aria-pressed={isSelected}
                      onClick={() => setSelected(thread.id)}
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium text-foreground">
                          {thread.title}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {names.get(thread.projectId) ?? ""}
                        </span>
                      </span>
                      {isSettled(thread) ? (
                        <Badge variant="secondary" size="sm">
                          Settled
                        </Badge>
                      ) : null}
                      <CheckIcon
                        aria-hidden
                        className={cn("size-4 shrink-0 text-primary", !isSelected && "invisible")}
                      />
                    </button>
                  );
                })
              )}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span id={`${id}-until`} className="text-xs font-medium text-muted-foreground">
              Wake when it
            </span>
            <ToggleGroup
              aria-labelledby={`${id}-until`}
              className="w-full *:flex-1"
              value={[until]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "settled" || value === "completed") setUntil(value);
              }}
            >
              <Toggle value="settled">Settled</Toggle>
              <Toggle value="completed">Successful run</Toggle>
            </ToggleGroup>
          </div>
          {target != null && isSettled(target) && until === "settled" ? (
            <p role="alert" className="text-sm text-destructive">
              This thread is already settled. Choose another thread or event.
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => finish(null)}>
            Cancel
          </Button>
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
