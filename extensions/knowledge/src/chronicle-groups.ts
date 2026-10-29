import type { TimelineInput } from "./chronicle-contract.js";
import type { LoadedRecord } from "./model.js";
import { recordDate } from "./temporal-query.js";

/** One derived entity Timeline row: a dated source, or a dated claim with no dated source. */
export type SourceRow = {
  record: LoadedRecord;
  date: string;
  summary: string;
  /** The entity's claims from this source; absent on a claim's own row. */
  claims?: number;
  note?: LoadedRecord;
};

type Group = {
  source: LoadedRecord;
  note?: LoadedRecord;
  event?: LoadedRecord;
  claims: LoadedRecord[];
};

/** Source grouping answers one entity's occurrence Timeline; reject inputs it cannot honor. */
export function assertSourceGrouping(input: TimelineInput) {
  if (
    input.group &&
    (!input.entity || input.kind || (input.timeField ?? "occurred_at") !== "occurred_at")
  ) {
    throw new Error(
      'group: "source" needs an entity and occurrence time, and does not take a kind filter.',
    );
  }
}

/**
 * Derive an entity's Timeline from records instead of page prose. A relationship
 * between the entity and a page makes that page a source and supplies the row's
 * note; a claim naming the entity joins the group of its source page, where a
 * source-event claim dates the row and stands in for a missing note. The row
 * date is the source's own occurrence date, else its source-event date. Claims
 * from an undated source, and dated claims without one, stay individual rows.
 * `associated` must be in a stable order so the chosen note is deterministic.
 */
export function sourceRows(
  entity: string,
  associated: readonly LoadedRecord[],
  byId: ReadonlyMap<string, LoadedRecord>,
): SourceRow[] {
  const groups = new Map<string, Group>();
  const group = (source: LoadedRecord) => {
    let found = groups.get(source.id);
    if (!found) {
      found = { source, claims: [] };
      groups.set(source.id, found);
    }
    return found;
  };
  const standalone: LoadedRecord[] = [];
  for (const record of associated) {
    const m = record.metadata;
    if (record.kind === "relationship") {
      const other = m.from === entity ? m.to : m.to === entity ? m.from : undefined;
      const page = other && other !== entity ? byId.get(other) : undefined;
      if (page?.kind === "page") {
        const found = group(page);
        // The first relationship with a written body is the note; an empty one still links.
        if (!found.note?.body.trim()) {
          found.note = record;
        }
      }
      continue;
    }
    if (record.kind !== "claim" || !m.entities?.includes(entity)) {
      continue;
    }
    const source = m.source_page && m.source_page !== entity ? byId.get(m.source_page) : undefined;
    if (!source) {
      standalone.push(record);
    } else if (m.source_event) {
      group(source).event ??= record;
    } else {
      group(source).claims.push(record);
    }
  }
  const rows: SourceRow[] = [];
  for (const { source, note, event, claims } of groups.values()) {
    const date = recordDate(source, "occurred_at") ?? (event && recordDate(event, "occurred_at"));
    if (!date) {
      standalone.push(...claims);
      continue;
    }
    const summary = note?.body.trim() || event?.body.trim() || "";
    rows.push({ record: source, date, summary, claims: claims.length, ...(note ? { note } : {}) });
  }
  for (const claim of standalone) {
    const date = recordDate(claim, "occurred_at");
    if (date) {
      rows.push({ record: claim, date, summary: claim.body.trim() });
    }
  }
  return rows;
}
