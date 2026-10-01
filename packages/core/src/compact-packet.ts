/** Opt-in v1 projection; full legacy packets remain available. */
import type { ContextPacket, EpicSupervisionRoute } from "./packet";
import type { SourceCursor } from "./source-page";

export const PICKUP_MAX_BYTES = 32768;
const excerpt = (text: string, length: number) => ({
  text: text.slice(0, length),
  omittedChars: Math.max(0, text.length - length),
});
const sourceRoute = (path: string, cursor?: SourceCursor | null) => ({
  cliArgs: [
    "source",
    path,
    ...(cursor ? ["--cursor", JSON.stringify(cursor)] : []),
    "--json",
  ],
  mcp: {
    tool: "source_page",
    arguments: { path, ...(cursor ? { cursor } : {}) },
  },
  continuation:
    "Follow any returned cursor before acting on omitted required source.",
});
export function compactContextPacket(
  packet: ContextPacket,
  lifecycle: { picked: boolean; started: unknown; telemetryWorkflow: string },
) {
  let guidanceFull = true;
  let bodyLimit = 4096,
    depLimit = 32,
    linkLimit = 6,
    commitLimit = 4;
  const build = () => {
    const body = excerpt(packet.task.body, bodyLimit);
    const title = excerpt(packet.task.fm.title ?? "", 160);
    const dependencies = packet.deps.slice(0, depLimit).map((d) => ({
      id: d.id,
      status: d.status ?? "unknown",
      title: excerpt(d.title ?? "", 160),
    }));
    const requiredReads = [];
    if (body.omittedChars)
      requiredReads.push({
        kind: "task-body",
        path: packet.task.path,
        version: packet.task.version,
        route: sourceRoute(packet.task.path),
      });
    if (dependencies.length !== packet.deps.length)
      requiredReads.push({
        kind: "dependencies",
        path: packet.task.path,
        version: packet.task.version,
        route: sourceRoute(packet.task.path),
        statuses: { cliArgs: ["task", "list", "--all", "--json"] },
        assessment:
          "Read complete depends_on source and resolve omitted IDs against live task-list source paths/statuses; unresolved IDs remain blockers.",
      });
    if (
      (!guidanceFull || packet.guidance.source?.nextCursor) &&
      packet.guidance.status !== "absent" &&
      packet.guidance.status !== "empty"
    )
      requiredReads.push({
        kind: "project-guidance",
        path: packet.guidance.path,
        version: packet.guidance.source?.sourceHash,
        route: sourceRoute(
          packet.guidance.path,
          guidanceFull ? packet.guidance.source?.nextCursor : undefined,
        ),
      });
    return {
      schema: "docket-pickup/v1",
      ...lifecycle,
      changed: lifecycle.started !== null,
      mutation: lifecycle.started !== null ? "applied" : "unchanged",
      suggestedSessionTitle:
        packet.suggestedSessionTitle.length <= 512
          ? packet.suggestedSessionTitle
          : null,
      titleIntentOmitted: packet.suggestedSessionTitle.length > 512,
      task: {
        path: packet.task.path,
        version: packet.task.version,
        fm: {
          id: packet.task.fm.id,
          type: packet.task.fm.type,
          status: packet.task.fm.status,
          priority: packet.task.fm.priority,
          title: title.text,
        },
        titleOmittedChars: title.omittedChars,
        body: body.text,
        bodyOmittedChars: body.omittedChars,
        metadata:
          "selected fields; complete authored frontmatter is available through the task source",
      },
      epic: packet.epic
        ? {
            path: packet.epic.path,
            id: packet.epic.id,
            status: packet.epic.status,
            title: excerpt(packet.epic.title ?? "", 160),
          }
        : null,
      deps: {
        items: dependencies,
        total: packet.deps.length,
        omitted: packet.deps.length - dependencies.length,
        nonDone: packet.deps.filter((d) => d.status !== "done").length,
        unresolved: packet.deps.filter((d) => d.status === undefined).length,
      },
      linked: {
        items: packet.linked.slice(0, linkLimit).map((l) => ({
          path: l.path,
          type: l.type,
          status: l.status,
          title: excerpt(l.title ?? "", 160),
        })),
        total: packet.linked.length,
        omitted: Math.max(0, packet.linked.length - linkLimit),
      },
      commits: {
        items: packet.commits.slice(0, commitLimit).map((c) => ({
          sha: c.sha,
          date: c.date,
          subject: excerpt(c.subject, 160),
        })),
        total: packet.commits.length,
        omitted: Math.max(0, packet.commits.length - commitLimit),
      },
      guidance: guidanceFull
        ? {
            ...packet.guidance,
            sourceVersion: packet.guidance.source?.sourceHash ?? null,
            sourceIncluded: true,
          }
        : {
            path: packet.guidance.path,
            status: packet.guidance.status,
            sourceVersion: packet.guidance.source?.sourceHash ?? null,
            sourceIncluded: false,
            assessment:
              "Read or reuse the exact retained guidance source/version and relevant continuations/procedures before acting.",
            details: sourceRoute(packet.guidance.path),
          },
      drift: packet.drift ?? null,
      instructions: packet.instructions ?? null,
      contextComplete: requiredReads.length === 0,
      requiredReads,
      limits: {
        maxBytes: PICKUP_MAX_BYTES,
        authority:
          "Pickup records lifecycle; it does not prove acceptance, integration, dependency readiness or that required guidance has been read.",
      },
      details: {
        task: sourceRoute(packet.task.path),
        guidance: sourceRoute(packet.guidance.path),
      },
    };
  };
  let result = build();
  while (
    Buffer.byteLength(JSON.stringify(result, null, 2)) > PICKUP_MAX_BYTES
  ) {
    if (bodyLimit) bodyLimit = 0;
    else if (linkLimit) linkLimit--;
    else if (commitLimit) commitLimit--;
    else if (guidanceFull) guidanceFull = false;
    else if (depLimit) depLimit--;
    else
      throw new Error(
        "Pickup identity/authority exceeds the compact budget; inspect retained lifecycle state and source before continuing.",
      );
    result = build();
  }
  return result;
}
export function compactEpicRoute(route: EpicSupervisionRoute) {
  const body = excerpt(route.epic.body, 4096);
  const result = {
    schema: "docket-epic-route/v1",
    outcome: route.outcome,
    route: route.route,
    mutation: "unchanged",
    changed: false,
    suggestedSessionTitle:
      route.suggestedSessionTitle.length <= 512
        ? route.suggestedSessionTitle
        : null,
    titleIntentOmitted: route.suggestedSessionTitle.length > 512,
    epic: {
      path: route.epic.path,
      fm: {
        id: route.epic.fm.id,
        type: route.epic.fm.type,
        status: route.epic.fm.status,
        title: excerpt(route.epic.fm.title ?? "", 160),
      },
      body: body.text,
      bodyOmittedChars: body.omittedChars,
    },
    contextComplete: body.omittedChars === 0,
    requiredReads: body.omittedChars ? [sourceRoute(route.epic.path)] : [],
    details: sourceRoute(route.epic.path),
    authority:
      "Non-mutating route. Read complete criteria before dispatch; no child selected.",
  };
  if (Buffer.byteLength(JSON.stringify(result, null, 2)) > PICKUP_MAX_BYTES)
    throw new Error(
      "Epic route exceeds the bounded budget; read its source before dispatch.",
    );
  return result;
}
