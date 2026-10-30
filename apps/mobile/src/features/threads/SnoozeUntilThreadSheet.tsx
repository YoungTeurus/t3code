import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useProjects, useThreadShells } from "../../state/entities";
import { useThreadSearch } from "../../state/queries";

export function SnoozeUntilThreadSheet(props: {
  readonly thread: EnvironmentThreadShell;
  readonly onClose: () => void;
  readonly onSnooze: (
    targetThreadId: ThreadId,
    until: "settled" | "completed",
    expectedDependencyId?: string,
  ) => void;
}) {
  const [dependency] = useState(props.thread.snoozeDependency ?? null);
  const [query, setQuery] = useState("");
  const [includeSettled, setIncludeSettled] = useState(false);
  const [selected, setSelected] = useState<ThreadId | null>(null);
  const [until, setUntil] = useState<"settled" | "completed">("settled");
  const threads = useThreadShells();
  const projects = useProjects();
  useThreadSearch([props.thread.environmentId], query, { titlesOnly: true });
  const names = new Map(
    projects
      .filter((project) => project.environmentId === props.thread.environmentId)
      .map((project) => [project.id, project.title]),
  );
  const candidates = threads
    .filter(
      (thread) =>
        thread.environmentId === props.thread.environmentId &&
        thread.id !== props.thread.id &&
        thread.deletedAt === null &&
        thread.archivedAt === null &&
        (includeSettled || (thread.settledOverride !== "settled" && thread.settledAt == null)) &&
        `${thread.title} ${names.get(thread.projectId) ?? ""}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const target = threads.find(
    (thread) => thread.environmentId === props.thread.environmentId && thread.id === selected,
  );
  const invalid =
    target == null ||
    (until === "settled" && (target.settledOverride === "settled" || target.settledAt != null));
  return (
    <Modal visible transparent animationType="fade" onRequestClose={props.onClose}>
      <View className="flex-1 items-center justify-center bg-backdrop px-6">
        <View className="max-h-[80%] w-full max-w-md rounded-3xl bg-screen p-6">
          <AppText accessibilityRole="header" className="text-xl font-t3-semibold">
            Snooze until another thread
          </AppText>
          <TextInput
            accessibilityLabel="Search threads"
            value={query}
            onChangeText={setQuery}
            placeholder="Search threads or projects"
            className="min-h-12 rounded-xl bg-subtle px-3 text-foreground"
          />
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: includeSettled }}
            onPress={() => setIncludeSettled(!includeSettled)}
          >
            <AppText>{includeSettled ? "☑" : "☐"} Include settled threads</AppText>
          </Pressable>
          <ScrollView className="max-h-64" keyboardShouldPersistTaps="handled">
            {candidates.map((thread) => (
              <Pressable
                key={thread.id}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected === thread.id }}
                onPress={() => setSelected(thread.id)}
                className="p-3"
              >
                <AppText>
                  {thread.title} · {names.get(thread.projectId) ?? ""}
                  {thread.settledOverride === "settled" || thread.settledAt != null
                    ? " · Settled"
                    : ""}
                </AppText>
              </Pressable>
            ))}
          </ScrollView>
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ checked: until === "settled" }}
            onPress={() => setUntil("settled")}
          >
            <AppText>Settled</AppText>
          </Pressable>
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ checked: until === "completed" }}
            onPress={() => setUntil("completed")}
          >
            <AppText>Successful run</AppText>
          </Pressable>
          {target != null &&
          (target.settledOverride === "settled" || target.settledAt != null) &&
          until === "settled" ? (
            <AppText>This thread is already settled. Choose another thread or event.</AppText>
          ) : null}
          <Button
            label="Snooze"
            disabled={invalid}
            onPress={() => {
              if (selected !== null)
                props.onSnooze(
                  selected,
                  until,
                  dependency?.targetThreadId === selected && dependency.until === until
                    ? dependency.dependencyId
                    : undefined,
                );
            }}
          />
          <Button label="Cancel" tone="secondary" onPress={props.onClose} />
        </View>
      </View>
    </Modal>
  );
}
