import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(".local/coffeejack.sqlite", { readOnly: true });
const rows = db
  .prepare(
    `SELECT id, tool, status, substr(detail,1,800) AS d, created
     FROM events
     WHERE tool IN ('terminal','inspect_pc')
     ORDER BY id DESC
     LIMIT 20`,
  )
  .all();
for (const r of rows) console.log(JSON.stringify(r));
