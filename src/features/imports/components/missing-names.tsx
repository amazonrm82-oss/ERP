"use client";

import { Checkbox } from "@/components/ui/field";
import { formatNumber } from "@/lib/format";

import {
  creatableCount,
  MAX_CREATED_NAMES,
  NAMES_ASK_ADMIN,
  NAMES_CREATE_HINT,
  NAMES_CREATE_LABEL,
  NAMES_NOT_CREATED,
  NAMES_TITLE,
  NAMES_TOO_MANY,
  NAMES_TRUNCATED,
  OWNERS_LEFT_EMPTY,
  PIPELINES_NOT_CREATED,
  type MissingNames,
} from "../list-names";

// CHN-05 (245) ג: the names of the file that the business does not have yet, shown before the import runs.

const SHOWN = 20;

function Names({ label, names }: { label: string; names: string[] }) {
  if (names.length === 0) return null;
  const more = names.length - SHOWN;
  return (
    <li>
      <span className="font-medium">{label}: </span>
      {names.slice(0, SHOWN).map((name, i) => (
        <span key={`${i}-${name}`}>
          {i > 0 ? ", " : ""}
          <bdi>{name}</bdi>
        </span>
      ))}
      {more > 0 ? ` ועוד ${formatNumber(more)}` : ""}
    </li>
  );
}

/** Whether there is anything to show. */
export function hasMissingNames(missing: MissingNames | null): missing is MissingNames {
  return Boolean(missing && (creatableCount(missing) > 0 || missing.unknownPipelines.length > 0 || missing.unknownOwners.length > 0 || missing.truncated));
}

export function MissingNamesPanel({
  missing,
  canCreate,
  create,
  onCreate,
}: {
  missing: MissingNames;
  canCreate: boolean;
  create: boolean;
  onCreate: (create: boolean) => void;
}) {
  const count = creatableCount(missing);
  return (
    <section aria-labelledby="import-missing-names" className="space-y-3 rounded-lg border border-line bg-surface p-4 text-sm sm:p-5">
      <h2 id="import-missing-names" className="text-md font-medium">
        {NAMES_TITLE}
      </h2>
      {count > 0 ? (
        <div className="space-y-2">
          <ul className="space-y-1">
            <Names label="סטטוסים" names={missing.statuses} />
            <Names label="מקורות" names={missing.sources} />
            {missing.stages.map((p) => (
              <Names key={p.pipelineId} label={`שלבים בתהליך המכירה "${p.pipelineName}"`} names={p.names} />
            ))}
          </ul>
          {!canCreate ? (
            <p className="text-ink-soft">{NAMES_ASK_ADMIN}</p>
          ) : count > MAX_CREATED_NAMES ? (
            <p className="text-ink-soft">{NAMES_TOO_MANY(count)}</p>
          ) : (
            <>
              <Checkbox label={NAMES_CREATE_LABEL} hint={NAMES_CREATE_HINT} checked={create} onChange={(e) => onCreate(e.target.checked)} />
              {!create ? <p className="text-ink-soft">{NAMES_NOT_CREATED}</p> : null}
            </>
          )}
        </div>
      ) : null}
      {missing.unknownPipelines.length > 0 ? (
        <div className="space-y-1">
          <ul>
            <Names label="תהליכי מכירה שלא קיימים" names={missing.unknownPipelines} />
          </ul>
          <p className="text-ink-soft">{PIPELINES_NOT_CREATED}</p>
        </div>
      ) : null}
      {missing.unknownOwners.length > 0 ? (
        <div className="space-y-1">
          <ul>
            <Names label="אחראים שלא נמצאו" names={missing.unknownOwners} />
          </ul>
          <p className="text-ink-soft">{OWNERS_LEFT_EMPTY}</p>
        </div>
      ) : null}
      {missing.truncated ? <p className="text-ink-soft">{NAMES_TRUNCATED}</p> : null}
    </section>
  );
}
