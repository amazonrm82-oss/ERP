import path from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAdmin, closePool } from "./helpers";

afterAll(closePool);

/**
 * src/lib/database.types.ts is written by hand, and every query in the app is
 * type-checked against it. This test compares it with the real schema built
 * from the migrations, so the two cannot drift apart unnoticed: a column that
 * is renamed, dropped, or made nullable in SQL fails here until the types
 * (and therefore the app code) are updated.
 */

type Field = { type: string; nullable: boolean };
type TableTypes = Record<string, Record<string, Field>>;

const typesFile = path.resolve(__dirname, "../../src/lib/database.types.ts");

function readAppTypes() {
  const program = ts.createProgram([typesFile], { strict: true, noEmit: true, skipLibCheck: true });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(typesFile);
  if (!source) throw new Error(`cannot read ${typesFile}`);

  const declaration = source.statements.find(
    (node): node is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(node) && node.name.text === "Database",
  );
  if (!declaration) throw new Error("type Database not found");
  const dbType = checker.getTypeFromTypeNode(declaration.type);

  const prop = (type: ts.Type, name: string): ts.Type => {
    const symbol = type.getProperty(name);
    if (!symbol) throw new Error(`property ${name} not found`);
    return checker.getTypeOfSymbolAtLocation(symbol, source);
  };
  const describeType = (type: ts.Type): Field => {
    const parts = type.isUnion() ? type.types : [type];
    const nullable = parts.some((p) => (p.flags & ts.TypeFlags.Null) !== 0);
    const rest = parts.filter((p) => (p.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) === 0);
    const names = rest.map((p) => checker.typeToString(p));
    let kind: string;
    if (type.aliasSymbol?.name === "Json" || names.some((n) => n.includes("Json"))) kind = "json";
    else if (rest.length > 0 && rest.every((p) => p.isStringLiteral())) kind = `enum:${names.map((n) => n.replace(/"/g, "")).sort().join("|")}`;
    else if (names.every((n) => n === "boolean" || n === "true" || n === "false")) kind = "boolean";
    else kind = [...new Set(names)].sort().join("|");
    return { type: kind, nullable };
  };

  const schema = prop(dbType, "public");
  const tables: TableTypes = {};
  for (const table of prop(schema, "Tables").getProperties()) {
    const row = prop(checker.getTypeOfSymbolAtLocation(table, source), "Row");
    tables[table.name] = {};
    for (const column of row.getProperties()) {
      tables[table.name][column.name] = describeType(checker.getTypeOfSymbolAtLocation(column, source));
    }
  }

  const functions: Record<string, { args: Record<string, { optional: boolean }> }> = {};
  for (const fn of prop(schema, "Functions").getProperties()) {
    const args = prop(checker.getTypeOfSymbolAtLocation(fn, source), "Args");
    functions[fn.name] = { args: {} };
    for (const arg of args.getProperties()) {
      functions[fn.name].args[arg.name] = { optional: (arg.flags & ts.SymbolFlags.Optional) !== 0 };
    }
  }
  return { tables, functions };
}

function expectedKind(dataType: string, udtName: string, enumLabels: Record<string, string[]>): string {
  if (dataType === "USER-DEFINED") return `enum:${[...(enumLabels[udtName] ?? [])].sort().join("|")}`;
  if (dataType === "ARRAY") return "string[]";
  if (["uuid", "text", "character", "character varying", "date", "timestamp with time zone", "inet"].includes(dataType)) return "string";
  if (["integer", "smallint", "bigint", "numeric"].includes(dataType)) return "number";
  if (dataType === "boolean") return "boolean";
  if (dataType === "jsonb" || dataType === "json") return "json";
  return `unmapped:${dataType}`;
}

describe("app types match the database", () => {
  let app: ReturnType<typeof readAppTypes>;
  let dbColumns: Record<string, Record<string, Field>>;
  let dbFunctions: Record<string, { names: string[]; defaults: number }>;

  beforeAll(async () => {
    app = readAppTypes();
    await asAdmin(async (q) => {
      const enums = await q<{ typname: string; labels: string[] }>(`
        select t.typname, array_agg(e.enumlabel::text order by e.enumsortorder) as labels
        from pg_type t join pg_enum e on e.enumtypid = t.oid
        join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' group by 1`);
      const enumLabels = Object.fromEntries(enums.rows.map((r) => [r.typname, r.labels]));

      const cols = await q<{ table_name: string; column_name: string; data_type: string; udt_name: string; is_nullable: string }>(`
        select table_name, column_name, data_type, udt_name, is_nullable
        from information_schema.columns where table_schema = 'public'`);
      dbColumns = {};
      for (const c of cols.rows) {
        (dbColumns[c.table_name] ??= {})[c.column_name] = {
          type: expectedKind(c.data_type, c.udt_name, enumLabels),
          nullable: c.is_nullable === "YES",
        };
      }

      const fns = await q<{ proname: string; names: string[] | null; defaults: number }>(`
        -- input arguments only: a "returns table" function lists its output columns in proargnames too
        select p.proname, p.pronargdefaults as defaults,
               case when p.proargmodes is null then p.proargnames
                    else array(select a.name from unnest(p.proargnames, p.proargmodes) as a(name, mode)
                                where a.mode in ('i', 'b', 'v')) end as names
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`);
      dbFunctions = Object.fromEntries(fns.rows.map((r) => [r.proname, { names: r.names ?? [], defaults: r.defaults }]));
    });
  });

  it("reads the hand-written types", () => {
    expect(Object.keys(app.tables).length).toBeGreaterThan(10);
    expect(app.tables.leads.full_name).toEqual({ type: "string", nullable: true });
    expect(app.tables.leads.organization_id).toEqual({ type: "string", nullable: false });
  });

  it("every table and column in the types exists in the database, with the same type and nullability", () => {
    const problems: string[] = [];
    for (const [table, columns] of Object.entries(app.tables)) {
      const real = dbColumns[table];
      if (!real) {
        problems.push(`table ${table} does not exist`);
        continue;
      }
      for (const [column, field] of Object.entries(columns)) {
        const actual = real[column];
        if (!actual) problems.push(`${table}.${column} does not exist`);
        else if (actual.type !== field.type) problems.push(`${table}.${column}: types say ${field.type}, database has ${actual.type}`);
        // the Json type itself includes null (a JSON null), so nullability says nothing there
        else if (field.type !== "json" && actual.nullable !== field.nullable)
          problems.push(`${table}.${column}: types say ${field.nullable ? "nullable" : "not null"}, database says ${actual.nullable ? "nullable" : "not null"}`);
      }
      for (const column of Object.keys(real)) {
        if (!(column in columns)) problems.push(`${table}.${column} is missing from the Row type`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("every RPC in the types exists with the same argument names and optional arguments", () => {
    const problems: string[] = [];
    for (const [name, fn] of Object.entries(app.functions)) {
      const real = dbFunctions[name];
      if (!real) {
        problems.push(`function ${name} does not exist`);
        continue;
      }
      const typed = Object.keys(fn.args);
      if (typed.slice().sort().join(",") !== real.names.slice().sort().join(","))
        problems.push(`${name}: types have (${typed.join(", ")}), database has (${real.names.join(", ")})`);
      const optionalInDb = new Set(real.names.slice(real.names.length - real.defaults));
      for (const arg of typed) {
        if (fn.args[arg].optional !== optionalInDb.has(arg))
          problems.push(`${name}.${arg}: optional in types = ${fn.args[arg].optional}, has default in database = ${optionalInDb.has(arg)}`);
      }
    }
    for (const name of Object.keys(dbFunctions)) {
      if (!(name in app.functions)) problems.push(`function ${name} is missing from the types`);
    }
    expect(problems).toEqual([]);
  });
});
