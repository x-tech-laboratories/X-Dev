// Where drizzle-kit reads the runs schema and writes its migrations; `npm run db:generate` runs it for every feature.
export default { dialect: "sqlite", schema: "./src/shared/runs/schema.ts", out: "./src/shared/runs/migrations" };
