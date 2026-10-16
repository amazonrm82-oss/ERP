import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  countRows,
  personExportReadme,
  personLinkFilter,
  personZipStream,
  uniqueIds,
  withoutOthersPrivate,
  zipFileName,
  type StoredFile,
} from "@/features/privacy-export/build";

async function collect(stream: ReadableStream<Uint8Array>): Promise<Record<string, Uint8Array>> {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return unzipSync(all);
}

const file = (id: string, declaredBytes: number): StoredFile => ({ id, name: `${id}.pdf`, path: `org/${id}`, declaredBytes });

// PRV-02: the pure parts of a person's export.
describe("person export (PRV-02)", () => {
  it("builds one filter over the person's records, or none", () => {
    expect(personLinkFilter({ lead: ["a", "b"], contact: ["c"], deal: [] })).toBe("lead_id.in.(a,b),contact_id.in.(c)");
    expect(personLinkFilter({ lead: [], contact: [], deal: ["d"] })).toBe("deal_id.in.(d)");
    expect(personLinkFilter({ lead: [], contact: [], deal: [] })).toBeNull();
  });

  it("keeps ids once, in order, without empty values", () => {
    expect(uniqueIds(["a", null, "b", "a", "", undefined, 3, "c"])).toEqual(["a", "b", "c"]);
  });

  it("leaves out a colleague's private note and its files, keeps one's own and the shared ones", () => {
    const me = "u-me";
    const activities = [
      { id: "n1", is_private: true, created_by: "u-colleague" },
      { id: "n2", is_private: true, created_by: me },
      { id: "n3", is_private: false, created_by: "u-colleague" },
      { id: "n4", is_private: true, created_by: null },
    ];
    const files = [
      { id: "f1", activity_id: "n1" },
      { id: "f2", activity_id: "n2" },
      { id: "f3", activity_id: "n3" },
      { id: "f4", activity_id: null },
      { id: "f5", activity_id: "n4" },
    ];
    const out = withoutOthersPrivate(activities, files, me);
    expect(out.activities.map((a) => a.id)).toEqual(["n2", "n3"]);
    expect(out.files.map((f) => f.id)).toEqual(["f2", "f3", "f4"]);
  });

  it("names files safely and never twice the same", () => {
    expect(zipFileName("1", "הצעה/מחיר:2026?.pdf")).toBe("files/1-הצעה_מחיר_2026_.pdf");
    expect(zipFileName("2", "a\u0001b")).toBe("files/2-a_b");
    expect(zipFileName("3", "   ")).toBe("files/3-file");
    expect(zipFileName("4", "x".repeat(400))).toHaveLength("files/4-".length + 150);
  });

  it("counts rows of the sections, without the lookups", () => {
    expect(countRows({ deals: [1, 2], activities: [1], people: { leads: [1] }, lookups: { users: [1, 2, 3] } })).toBe(3);
  });

  it("README lists what was left out, and says nothing when nothing was", () => {
    expect(personExportReadme(["big.zip"])).toContain("לא נכנסו לקובץ הזה 1 קבצים");
    expect(personExportReadme(["big.zip"])).toContain("- big.zip");
    expect(personExportReadme([])).not.toContain("לא נכנסו");
    expect(personExportReadme([])).toContain("הערות פרטיות של אחרים");
  });

  it("streams a ZIP that opens: the data, the files and the README", async () => {
    const reads: string[] = [];
    const entries = await collect(
      personZipStream({ kind: "lead", id: "x" }, [file("a", 3), file("b", 2)], async (path) => {
        reads.push(path);
        return new Uint8Array(path === "org/a" ? [1, 2, 3] : [4, 5]);
      }),
    );
    expect(Object.keys(entries).sort()).toEqual(["README.txt", "files/a-a.pdf", "files/b-b.pdf", "person.json"]);
    expect(JSON.parse(strFromU8(entries["person.json"]))).toEqual({ kind: "lead", id: "x" });
    expect([...entries["files/b-b.pdf"]]).toEqual([4, 5]);
    expect(reads).toEqual(["org/a", "org/b"]);
  });

  it("the cap counts the bytes really read, not the declared size; unreadable files are listed too", async () => {
    // a declares 1 byte and holds 8; b holds 3; with a cap of 10 the second one no longer fits
    const sizes: Record<string, number> = { "org/a": 8, "org/b": 3, "org/c": 2 };
    const entries = await collect(
      personZipStream({}, [file("a", 1), file("b", 1), file("gone", 1), file("c", 1)], async (path) => (path in sizes ? new Uint8Array(sizes[path]) : null), 10),
    );
    expect(Object.keys(entries).sort()).toEqual(["README.txt", "files/a-a.pdf", "files/c-c.pdf", "person.json"]);
    const readme = strFromU8(entries["README.txt"]);
    expect(readme).toContain("לא נכנסו לקובץ הזה 2 קבצים");
    expect(readme).toContain("- b.pdf");
    expect(readme).toContain("- gone.pdf");
  });

  it("a declared size already past the cap is not even read, and a failed read is listed, not fatal", async () => {
    const reads: string[] = [];
    const entries = await collect(
      personZipStream({}, [file("huge", 50), file("bad", 1)], async (path) => {
        reads.push(path);
        throw new Error("storage down");
      }, 10),
    );
    expect(reads).toEqual(["org/bad"]);
    expect(Object.keys(entries).sort()).toEqual(["README.txt", "person.json"]);
    expect(strFromU8(entries["README.txt"])).toContain("לא נכנסו לקובץ הזה 2 קבצים");
  });

  it("reads one file per pull, so a slow reader never makes it read ahead", async () => {
    let reads = 0;
    const stream = personZipStream({}, [file("a", 1), file("b", 1), file("c", 1)], async () => {
      reads += 1;
      return new Uint8Array(4);
    });
    const reader = stream.getReader();
    await reader.read();
    // after the first chunk at most one file was read (the stream's default high-water mark is one chunk)
    expect(reads).toBeLessThanOrEqual(1);
    await reader.cancel();
  });
});
