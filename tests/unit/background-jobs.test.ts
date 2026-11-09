import { createHmac } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { ESLint } from "eslint";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// the import's own steps and the export are the browser path's code; here they are stand-ins, so the tests are about
// what the background handler does around them (the database tests judge the rights)
const core = vi.hoisted(() => ({
  startImportCore: vi.fn(),
  importChunkCore: vi.fn(),
  finishImportCore: vi.fn(),
  buildFullExport: vi.fn(),
}));
vi.mock("@/features/imports/run-core", () => ({
  startImportCore: core.startImportCore,
  importChunkCore: core.importChunkCore,
  finishImportCore: core.finishImportCore,
}));
vi.mock("@/features/imports/export", () => ({ buildFullExport: core.buildFullExport }));

import { createExportHandler, createImportHandler, type BackgroundCalls, type BackgroundDeps } from "@/features/background/handlers";
import { addOutcomes, backgroundSourceSchema, EXPORT_TOO_LARGE, parseBegun, parseTokenAnswer, readCounts, uploadTooLarge } from "@/features/background/rules";
import * as userToken from "@/features/background/user-token";
import { createBackgroundTokenSource, TokenRefused } from "@/features/background/user-token";
import type { ClaimedJob } from "@/features/jobs/registry";
import { AGREEMENT_VERSION } from "@/features/legal/agreement";

const root = process.cwd();
const ORG = "33333333-3333-4333-8333-333333333333";
const REQ = "55555555-5555-4555-8555-555555555555";
const USER = "66666666-6666-4666-8666-666666666666";
const SESSION = "88888888-8888-4888-8888-888888888888";
const IMPORT_JOB = "77777777-7777-4777-8777-777777777777";
const SECRET = "s".repeat(40);
const CLAIMS = { sub: USER, role: "authenticated", aal: "aal2", session_id: SESSION, crm_background: REQ };

beforeAll(() => {
  process.env.SUPABASE_JWT_SECRET = SECRET;
});

const job = (kind: "import.run" | "export.run"): ClaimedJob => ({
  id: "11111111-1111-4111-8111-111111111111",
  lease: "22222222-2222-4222-8222-222222222222",
  kind,
  organization_id: ORG,
  payload: { request_id: REQ, user_id: USER },
  attempt: 1,
});

const begun = (over: Record<string, unknown> = {}) => ({
  ok: true,
  kind: "import",
  request_id: REQ,
  duplicate_mode: "skip",
  import_job_id: null,
  rows_done: 0,
  counts: {},
  source_path: `${ORG}/${REQ}/source.json`,
  ...over,
});

/** The lease's end the token check answers: 15 minutes from the clock's start unless a test says otherwise. */
const lease = (seconds = 900, from = Date.now()) => new Date(from + seconds * 1000).toISOString();

/** A stand-in for the worker's service client: only background_job_token, logged. */
function service(answer: () => unknown, log: Array<[string, ...unknown[]]>) {
  return {
    rpc: async (name: string, args: unknown) => {
      log.push(["token", name, args]);
      return { data: answer(), error: null };
    },
  } as never;
}

function calls(beginAnswer: unknown, tokenAnswer: () => unknown = () => ({ ok: true, claims: CLAIMS, locked_until: lease() })) {
  const log: Array<[string, ...unknown[]]> = [];
  const c: BackgroundCalls = {
    begin: async () => beginAnswer,
    progress: async (_job, importJobId, rows, counts) => {
      log.push(["progress", importJobId, rows, counts]);
      return "ok";
    },
    end: async (_job, ok, counts, message, path) => {
      log.push(["end", ok, counts, message, path]);
      return "ended";
    },
  };
  return { c, log, tokenAnswer };
}

function fakeClient(source: unknown, token: () => Promise<string>) {
  const uploads: Array<[string, unknown]> = [];
  const rpcs: Array<[string, unknown]> = [];
  let uploadError: unknown = null;
  const client = {
    storage: {
      from: () => ({
        download: async () => {
          await token();
          return { data: new Blob([JSON.stringify(source)]), error: null };
        },
        upload: async (path: string, body: unknown) => {
          await token();
          uploads.push([path, body]);
          return { error: uploadError };
        },
      }),
    },
    rpc: async (name: string, args: unknown) => {
      await token();
      rpcs.push([name, args]);
      return { error: null };
    },
  };
  return { client, uploads, rpcs, failUpload: (e: unknown) => (uploadError = e) };
}

/** Deps whose client asks for the token on every call, like supabase-js's accessToken, through the real token source. */
function deps(made: ReturnType<typeof calls>, source: unknown, extra: Partial<BackgroundDeps> & { now?: () => number } = {}) {
  let fake: ReturnType<typeof fakeClient> | null = null;
  const d: BackgroundDeps = {
    calls: made.c,
    tokenSource: (j) => createBackgroundTokenSource(service(made.tokenAnswer, made.log), j, { now: extra.now }),
    userClient: (s) => {
      fake = fakeClient(source, () => s.token());
      return fake.client as never;
    },
    ...extra,
  };
  return { d, fake: () => fake as unknown as ReturnType<typeof fakeClient> };
}

const source = (rows: number, mode = "skip") => ({
  version: 1,
  entity: "lead",
  mode,
  fileName: "leads.xlsx",
  mapping: ["full_name"],
  rows: Array.from({ length: rows }, (_, i) => [`ליד ${i}`]),
});

const decode = (token: string) => {
  const [header, payload, signature] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString()),
    payload: JSON.parse(Buffer.from(payload, "base64url").toString()),
    valid: signature === createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url"),
  };
};

beforeEach(() => {
  core.startImportCore.mockReset().mockResolvedValue({ ok: true, data: { jobId: IMPORT_JOB } });
  core.importChunkCore.mockReset().mockImplementation(async (_s, _o, _j, input: { rows: string[][]; firstRow: number }) => ({
    ok: true,
    data: { outcomes: input.rows.map((_, i) => ({ row: input.firstRow + i, status: "created" })), stopped: null },
  }));
  core.finishImportCore.mockReset().mockResolvedValue({ ok: true });
  core.buildFullExport.mockReset().mockResolvedValue({ zip: new Uint8Array([1, 2, 3]), rows: 42 });
});

describe("IMP-04: the person's token (owner (160) א, review 1-2)", () => {
  it("is signed only from background_job_token's answer for this job and lease, with the app's legal version", async () => {
    const log: Array<[string, ...unknown[]]> = [];
    const src = createBackgroundTokenSource(service(() => ({ ok: true, claims: CLAIMS, locked_until: lease(900, 1_000_000) }), log), job("import.run"), {
      now: () => 1_000_000,
    });
    const token = decode(await src.token());
    expect(log).toEqual([["token", "background_job_token", { p_job: job("import.run").id, p_lease: job("import.run").lease, p_legal_version: AGREEMENT_VERSION }]]);
    expect(token.header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(token.valid).toBe(true);
    expect(token.payload).toEqual({ aud: "authenticated", sub: USER, role: "authenticated", aal: "aal2", session_id: SESSION, crm_background: REQ, iat: 1_000, exp: 1_600 });
  });

  it("review 1: no signer is exported; nothing outside the module can supply claims", () => {
    expect(Object.keys(userToken).sort()).toEqual(["TokenRefused", "backgroundJobsReady", "createBackgroundTokenSource", "createUserClient"]);
    // the source's only call is background_job_token, and it takes a client, a job and a lease, never claims
    const code = readFileSync(join(root, "src/features/background/user-token.ts"), "utf8");
    expect([...code.matchAll(/\.rpc\(\s*"([a-z_]+)"/g)].map((m) => m[1])).toEqual(["background_job_token"]);
    expect(code).not.toMatch(/export function signUserToken/);
  });

  it("review 2: a token never outlives the lease", async () => {
    const src = createBackgroundTokenSource(service(() => ({ ok: true, claims: CLAIMS, locked_until: lease(120, 1_000_000) }), []), job("import.run"), {
      now: () => 1_000_000,
    });
    expect(decode(await src.token()).payload).toMatchObject({ iat: 1_000, exp: 1_120 });
    // a lease already over is never signed
    const over = createBackgroundTokenSource(service(() => ({ ok: true, claims: CLAIMS, locked_until: lease(0, 1_000_000) }), []), job("import.run"), {
      now: () => 1_000_000,
    });
    await expect(over.token()).rejects.toBeInstanceOf(TokenRefused);
    expect(over.refused()).toBe("stale");
  });

  it("is signed only for an authenticated person with a session, this order and this job's person", async () => {
    expect(parseTokenAnswer({ ok: true, claims: CLAIMS, locked_until: lease() }, REQ).ok).toBe(true);
    expect(parseTokenAnswer({ ok: false, reason: "session_ended" }, REQ)).toEqual({ ok: false, reason: "session_ended" });
    for (const claims of [
      { ...CLAIMS, role: "service_role" },
      { ...CLAIMS, sub: "x" },
      { ...CLAIMS, aal: "aal3" },
      { ...CLAIMS, session_id: undefined },
      { ...CLAIMS, crm_background: USER },
      null,
    ]) {
      expect(parseTokenAnswer({ ok: true, claims, locked_until: lease() }, REQ).ok, JSON.stringify(claims)).toBe(false);
    }
    expect(parseTokenAnswer({ ok: true, claims: CLAIMS }, REQ).ok).toBe(false);
    const parsed = parseTokenAnswer({ ok: true, claims: { ...CLAIMS, role_override: "admin" }, locked_until: lease() }, REQ);
    expect(parsed.ok && parsed.claims).toEqual(CLAIMS);
    expect(parseBegun(begun({ claims: CLAIMS }))).not.toHaveProperty("claims");
    // the database answering another person than the job's: refused
    const other = createBackgroundTokenSource(service(() => ({ ok: true, claims: { ...CLAIMS, sub: SESSION }, locked_until: lease(900, Date.now()) }), []), job("import.run"));
    await expect(other.token()).rejects.toBeInstanceOf(TokenRefused);
    expect(other.refused()).toBe("person_changed");
  });

  it("asks the database again before every signing: the first one and each refresh; a refusal is final", async () => {
    let now = 0;
    const log: Array<[string, ...unknown[]]> = [];
    let refuse = false;
    const src = createBackgroundTokenSource(service(() => (refuse ? { ok: false, reason: "agreement" } : { ok: true, claims: CLAIMS, locked_until: lease(3600) }), log), job("import.run"), {
      now: () => now,
    });
    const first = await src.token();
    now = 60_000;
    expect(await src.token()).toBe(first);
    // within a minute of the end: asked again, signed again
    now = 541_000;
    const second = await src.token();
    expect(second).not.toBe(first);
    expect(log).toHaveLength(2);
    now = 1_200_000;
    refuse = true;
    await expect(src.token()).rejects.toBeInstanceOf(TokenRefused);
    expect(src.refused()).toBe("agreement");
    refuse = false;
    await expect(src.token()).rejects.toBeInstanceOf(TokenRefused);
    expect(log).toHaveLength(3);
  });

  it("SUPABASE_JWT_SECRET is named in one file of src only, and lint refuses it anywhere else", async () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx|mjs|js)$/.test(name) && readFileSync(path, "utf8").includes("SUPABASE_JWT_SECRET")) files.push(path.slice(root.length + 1));
      }
    };
    walk(join(root, "src"));
    expect(files).toEqual(["src/features/background/user-token.ts"]);
    const eslint = new ESLint({ cwd: root });
    const elsewhere = join(root, "src/features/x/y.ts");
    for (const code of [
      "export const s = process.env.SUPABASE_JWT_SECRET;\n",
      'export const s = process.env["SUPABASE_JWT_SECRET"];\n',
      "const { SUPABASE_JWT_SECRET: s } = process.env;\nexport { s };\n",
    ]) {
      expect((await eslint.lintText(code, { filePath: elsewhere }))[0].messages.map((m) => m.ruleId), code).toContain("no-restricted-syntax");
    }
    const signer = await eslint.lintText(readFileSync(join(root, "src/features/background/user-token.ts"), "utf8"), {
      filePath: join(root, "src/features/background/user-token.ts"),
    });
    expect(signer[0].messages.filter((m) => m.ruleId === "no-restricted-syntax")).toEqual([]);
  }, 60_000);

  it("review 1: only the worker may import the token source or the user client; pages and actions only backgroundJobsReady", async () => {
    const eslint = new ESLint({ cwd: root });
    const restricted = async (code: string, file: string) =>
      (await eslint.lintText(code, { filePath: join(root, file) }))[0].messages.filter((m) => m.ruleId === "no-restricted-imports").length;
    for (const name of ["createBackgroundTokenSource", "createUserClient"]) {
      const code = `import { ${name} } from "@/features/background/user-token";\nexport const x = ${name};\n`;
      for (const file of ["src/features/background/actions.ts", "src/app/o/[orgId]/settings/import/page.tsx", "src/features/background/handlers.ts", "src/features/intake/server.ts"]) {
        expect(await restricted(code, file), `${name} in ${file}`).toBe(1);
      }
      expect(await restricted(code.replace("@/features/background/user-token", "./user-token"), "src/features/background/queries.ts"), `${name} relative`).toBe(1);
      expect(await restricted(code, "src/features/jobs/run-server.ts"), `${name} in the worker`).toBe(0);
    }
    expect(await restricted('import * as t from "@/features/background/user-token";\nexport const x = t;\n', "src/features/background/actions.ts")).toBe(1);
    expect(await restricted('import { backgroundJobsReady } from "@/features/background/user-token";\nexport const x = backgroundJobsReady;\n', "src/features/background/actions.ts")).toBe(0);
    // the real tree passes
    const real = await eslint.lintFiles(["src/features/jobs/run-server.ts", "src/features/background", "src/app/o/[orgId]/settings/import"]);
    expect(real.flatMap((r) => r.messages.filter((m) => m.ruleId === "no-restricted-imports"))).toEqual([]);
  }, 120_000);

  it("the handlers and the signer never hold the service key", () => {
    for (const file of ["src/features/background/handlers.ts", "src/features/background/user-token.ts"]) {
      expect(readFileSync(join(root, file), "utf8"), file).not.toMatch(/supabase\/service|createServiceClient|SERVICE_ROLE/);
    }
  });
});

describe("IMP-04: the rules", () => {
  it("counts outcomes as the wizard does and reads stored counts safely", () => {
    expect(addOutcomes({ created: 1, updated: 0, skipped: 0, failed: 0 }, [{ status: "created" }, { status: "skipped" }, { status: "ok" }, { status: "failed" }])).toEqual({
      created: 2,
      updated: 0,
      skipped: 1,
      failed: 1,
    });
    expect(readCounts({ created: 3, updated: -1, skipped: "2" })).toEqual({ created: 3, updated: 0, skipped: 0, failed: 0 });
    expect(readCounts(null)).toEqual({ created: 0, updated: 0, skipped: 0, failed: 0 });
  });

  it("accepts only the uploaded shape", () => {
    expect(backgroundSourceSchema.safeParse(source(3)).success).toBe(true);
    expect(backgroundSourceSchema.safeParse({ ...source(3), version: 2 }).success).toBe(false);
    expect(backgroundSourceSchema.safeParse({ ...source(0) }).success).toBe(false);
  });

  it("knows a refusal for size (162)", () => {
    expect(uploadTooLarge({ status: 413 })).toBe(true);
    expect(uploadTooLarge({ statusCode: "413" })).toBe(true);
    expect(uploadTooLarge({ message: "The object exceeded the maximum allowed size" })).toBe(true);
    expect(uploadTooLarge({ message: "network down" })).toBe(false);
    expect(uploadTooLarge(null)).toBe(false);
  });
});

describe("IMP-04: the import handler", () => {
  it("a refusal of begin runs nothing and signs nothing", async () => {
    const made = calls({ ok: false, reason: "not_allowed" });
    const { c, log } = made;
    const userClient = vi.fn();
    const tokenSource = vi.fn();
    expect(await createImportHandler({ calls: c, tokenSource, userClient })(job("import.run"))).toEqual({
      status: "ended",
      reason: "not_allowed",
    });
    expect(userClient).not.toHaveBeenCalled();
    expect(tokenSource).not.toHaveBeenCalled();
    expect(log).toEqual([]);
    expect(core.startImportCore).not.toHaveBeenCalled();
  });

  it("a refusal of the first signing runs nothing", async () => {
    const made = calls(begun(), () => ({ ok: false, reason: "session_ended" }));
    const { log } = made;
    const { d, fake } = deps(made, source(10));
    expect(await createImportHandler(d)(job("import.run"))).toEqual({ status: "ended", reason: "session_ended" });
    expect(fake()).toBeNull();
    expect(log.map((l) => l[0])).toEqual(["token"]);
    expect(core.startImportCore).not.toHaveBeenCalled();
  });

  it("runs every chunk as the person, saves the place after each, and ends with the counts", async () => {
    const made = calls(begun());
    const { log } = made;
    const { d } = deps(made, source(600));
    expect(await createImportHandler(d)(job("import.run"))).toEqual({ status: "done" });
    expect(core.startImportCore.mock.calls[0][0]).toMatchObject({ userId: USER });
    expect(core.startImportCore.mock.calls[0][2]).toMatchObject({ entity: "lead", mode: "skip", totalRows: 600 });
    expect(core.importChunkCore.mock.calls.map((call) => (call[3] as { firstRow: number }).firstRow)).toEqual([1, 251, 501]);
    expect(log.filter((l) => l[0] === "progress").map((l) => l[2])).toEqual([0, 250, 500, 600]);
    // signed once, before anything was read (the run is far shorter than the token)
    expect(log.filter((l) => l[0] === "token")).toHaveLength(1);
    expect(log[0][0]).toBe("token");
    expect(core.finishImportCore).toHaveBeenCalledWith(expect.anything(), ORG, IMPORT_JOB, expect.objectContaining({ created: 600, stopped: false }));
    expect(log.at(-1)).toEqual(["end", true, { created: 600, updated: 0, skipped: 0, failed: 0 }, null, null]);
  });

  it("(163) refuses a file whose rule is not the order's, or is create", async () => {
    for (const [mode, ordered] of [["create", "skip"], ["update", "skip"]]) {
      const made = calls(begun({ duplicate_mode: ordered }));
      const { log } = made;
      const { d } = deps(made, source(10, mode));
      expect(await createImportHandler(d)(job("import.run"))).toEqual({ status: "done" });
      expect(core.startImportCore).not.toHaveBeenCalled();
      expect(log.at(-1)?.[1]).toBe(false);
    }
  });

  it("stops at its time budget with its place saved, and goes on from there", async () => {
    let now = 0;
    const tick = () => now;
    core.importChunkCore.mockImplementation(async (_s, _o, _j, input: { rows: string[][]; firstRow: number }) => {
      now += 30_000;
      return { ok: true, data: { outcomes: input.rows.map((_, i) => ({ row: input.firstRow + i, status: "created" })), stopped: null } };
    });
    const first = calls(begun());
    expect(await createImportHandler(deps(first, source(600), { now: tick, budgetMs: 40_000 }).d)(job("import.run"))).toEqual({ status: "yield" });
    expect(first.log.filter((l) => l[0] === "end")).toEqual([]);
    expect(core.finishImportCore).not.toHaveBeenCalled();
    // the next run starts where the saved place says, with the import job already made, and signs again (checked again)
    const second = calls(begun({ import_job_id: IMPORT_JOB, rows_done: 500, counts: { created: 500, updated: 0, skipped: 0, failed: 0 } }));
    core.importChunkCore.mockClear();
    now = 0;
    expect(await createImportHandler(deps(second, source(600), { now: tick, budgetMs: 40_000 }).d)(job("import.run"))).toEqual({ status: "done" });
    expect(core.startImportCore).toHaveBeenCalledTimes(1);
    expect(second.log[0][0]).toBe("token");
    expect(core.importChunkCore.mock.calls.map((call) => (call[3] as { firstRow: number }).firstRow)).toEqual([501]);
    expect(second.log.at(-1)).toEqual(["end", true, { created: 600, updated: 0, skipped: 0, failed: 0 }, null, null]);
  });

  it("a refresh the database refuses stops the work at once (the database already ended the order)", async () => {
    let now = 0;
    let answers = 0;
    const made = calls(begun(), () => (++answers === 1 ? { ok: true, claims: CLAIMS, locked_until: lease(3600) } : { ok: false, reason: "not_allowed" }));
    const { log } = made;
    // each chunk takes 6 minutes, so the second needs a fresh token
    core.importChunkCore.mockImplementation(async (s: { supabase: { rpc: (n: string, a: unknown) => Promise<unknown> } }, _o, _j, input: { rows: string[][]; firstRow: number }) => {
      now += 360_000;
      await s.supabase.rpc("touch", {});
      return { ok: true, data: { outcomes: input.rows.map((_, i) => ({ row: input.firstRow + i, status: "created" })), stopped: null } };
    });
    const { d } = deps(made, source(600), { now: () => now, budgetMs: 10_000_000 });
    expect(await createImportHandler(d)(job("import.run"))).toEqual({ status: "ended", reason: "not_allowed" });
    expect(log.filter((l) => l[0] === "token")).toHaveLength(2);
    expect(log.some((l) => l[0] === "end")).toBe(false);
  });

  it("a refused chunk stops the import with the browser path's own message", async () => {
    const made = calls(begun());
    const { log } = made;
    core.importChunkCore.mockResolvedValue({ ok: false, message: "ייבוא מותר לבעלים, למנהלי מערכת ולמנהלי צוות." });
    expect(await createImportHandler(deps(made, source(10)).d)(job("import.run"))).toEqual({ status: "done" });
    expect(core.finishImportCore).toHaveBeenCalledWith(expect.anything(), ORG, IMPORT_JOB, expect.objectContaining({ stopped: true }));
    expect(log.at(-1)).toEqual(["end", false, { created: 0, updated: 0, skipped: 0, failed: 0 }, "ייבוא מותר לבעלים, למנהלי מערכת ולמנהלי צוות.", null]);
  });

  it("a cancel seen in progress closes the import as stopped and ends nothing more", async () => {
    const made = calls(begun());
    const { c, log } = made;
    c.progress = async (_j, id, rows) => {
      log.push(["progress", id, rows]);
      return rows > 0 ? "cancelled" : "ok";
    };
    expect(await createImportHandler(deps(made, source(600)).d)(job("import.run"))).toEqual({ status: "done" });
    expect(core.importChunkCore).toHaveBeenCalledTimes(1);
    expect(core.finishImportCore).toHaveBeenCalledWith(expect.anything(), ORG, IMPORT_JOB, expect.objectContaining({ stopped: true }));
    expect(log.some((l) => l[0] === "end")).toBe(false);
  });

  it("a file that is not the uploaded shape ends the order", async () => {
    const made = calls(begun());
    const { log } = made;
    expect(await createImportHandler(deps(made, { version: 1, rows: "x" }).d)(job("import.run"))).toEqual({ status: "done" });
    expect(core.startImportCore).not.toHaveBeenCalled();
    expect(log.at(-1)?.[1]).toBe(false);
  });
});

describe("IMP-04: the export handler", () => {
  it("builds with the person's client, logs before keeping the file, and keeps it in the order's folder", async () => {
    const made = calls(begun({ kind: "export", duplicate_mode: null }));
    const { log } = made;
    const { d, fake } = deps(made, null);
    expect(await createExportHandler(d)(job("export.run"))).toEqual({ status: "done" });
    expect(core.buildFullExport).toHaveBeenCalledWith(ORG, fake().client);
    expect(fake().rpcs).toEqual([["log_export", { p_org: ORG, p_kind: "full", p_report: null, p_rows: 42 }]]);
    expect(fake().uploads).toHaveLength(1);
    const path = fake().uploads[0][0];
    expect(path).toMatch(new RegExp(`^${ORG}/${REQ}/[0-9a-f-]{36}\\.zip$`));
    expect(log.at(-1)).toEqual(["end", true, { rows: 42 }, null, path]);
  });

  it("(162) over the upload limit: ends with the notice that points to the direct download", async () => {
    const made = calls(begun({ kind: "export", duplicate_mode: null }));
    const { log } = made;
    const { d, fake } = deps(made, null);
    const handler = createExportHandler(d);
    core.buildFullExport.mockImplementation(async () => {
      fake().failUpload({ statusCode: "413", message: "Payload too large" });
      return { zip: new Uint8Array([1]), rows: 42 };
    });
    expect(await handler(job("export.run"))).toEqual({ status: "done" });
    expect(log.at(-1)).toEqual(["end", false, { rows: 42 }, EXPORT_TOO_LARGE, null]);
    expect(EXPORT_TOO_LARGE).toContain("הורדת ייצוא מלא");
  });

  it("another upload failure is tried again", async () => {
    const made = calls(begun({ kind: "export", duplicate_mode: null }));
    const { log } = made;
    const { d, fake } = deps(made, null);
    core.buildFullExport.mockImplementation(async () => {
      fake().failUpload({ message: "network down" });
      return { zip: new Uint8Array([1]), rows: 42 };
    });
    expect(await createExportHandler(d)(job("export.run"))).toMatchObject({ status: "failed" });
    expect(log.some((l) => l[0] === "end")).toBe(false);
  });

  it("no log, no file", async () => {
    const made = calls(begun({ kind: "export", duplicate_mode: null }));
    const { log } = made;
    const { d, fake } = deps(made, null);
    core.buildFullExport.mockImplementation(async () => {
      fake().client.rpc = async () => ({ error: { message: "x" } as never });
      return { zip: new Uint8Array([1]), rows: 42 };
    });
    await createExportHandler(d)(job("export.run"));
    expect(fake().uploads).toEqual([]);
    expect(log.at(-1)?.[1]).toBe(false);
  });

  it("a begin answer of the other kind runs nothing", async () => {
    const made = calls(begun({ kind: "import" }));
    expect(await createExportHandler(deps(made, null).d)(job("export.run"))).toMatchObject({ status: "failed", final: true });
    expect(core.buildFullExport).not.toHaveBeenCalled();
  });
});

describe("IMP-04: the runner hands a yielding job back uncounted", () => {
  it("calls finish_job with started = false and counts it released", async () => {
    const { runJobs } = await import("@/features/jobs/runner");
    const { createRegistry } = await import("@/features/jobs/registry");
    const finishes: unknown[] = [];
    let claimed = false;
    const summary = await runJobs(
      {
        claim: async () => {
          if (claimed) return [];
          claimed = true;
          return [{ ...job("import.run") }];
        },
        finish: async (_job, report) => {
          finishes.push(report);
          return "released";
        },
      },
      createRegistry({ "import.run": async () => ({ status: "yield" }) }),
      { batch: 1 },
    );
    expect(finishes).toEqual([{ ok: false, error: null, final: false, started: false }]);
    expect(summary).toMatchObject({ claimed: 1, released: 1, failed: 0, unconfirmed: 0 });
  });
});
