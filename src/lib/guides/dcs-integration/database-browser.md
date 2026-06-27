# Database browser

The Database panel is a read-only browser over the SQLite databases that the in-DCS bridge writes under your DCS write directory. Browse the discovered files, inspect each table, and run `SELECT` queries against them — all without leaving the editor and without ever modifying the data.

## Opening the panel

In the right-hand tool rail, click the **Database** icon, or choose **View → Database**. The header shows the resolved DCS write directory (or *"no DCS write dir detected"*) and a **Refresh** button that re-discovers databases.

## Where the databases come from

The bridge DLL (`dcs_studio.dll`) writes these SQLite files under your DCS write dir while your scripts run — see the **Injecting the bridge** guide. DCS Studio only ever *reads* them: every connection is opened read-only. Thanks to SQLite's WAL mode it can read a database while DCS still has it open, and it works just as well when DCS is closed. Discovery runs automatically when you open a project; **Refresh** re-scans on demand.

## Browsing a database

1. The first view lists every discovered database with its name and on-disk size. Click one to open it.
2. The opened view shows the database's **tables** as chips, each with its row count (hover for the column and row counts). Use the **Databases** back button to return to the list.
3. Click a table chip, or type SQL into the query box (`SELECT * FROM …`), and click **Run**.
4. Results appear in a grid below, with a summary line above it.

## Result limits and read-only safety

- **Row cap.** A query returns at most **1000 rows**. A larger result is truncated and the summary flags it as capped, so a runaway `SELECT` can never flood the grid.
- **Read-only.** The connection is opened read-only, so a write statement (`INSERT`, `UPDATE`, `DELETE`) fails with an error and leaves the database unchanged. Errors — a SQL mistake, an unreadable file, or a refused path — appear in a red banner.
- **Confined to the write root.** Every path is checked to stay under the DCS write directory; absolute escapes, `..` traversal, and drive changes are refused before any file is touched.

## When there are no databases

If nothing is found you will see:

```
No databases found under the DCS write dir.
They appear once dcs_studio.dll has written one.
```

Below that, a **Browse SQLite recipes →** button opens the Recipes panel focused on its **SQLite** category — one click from the snippets that create these databases. (While DCS Studio is still discovering, it shows *"Discovering databases…"* instead.)

## Tips and gotchas

- **You cannot edit data here.** This is a viewer for what your mod wrote — by design, it never changes the databases.
- **Don't see your database?** Make sure the bridge is injected and your script has actually written it, then click **Refresh**. The panel reads files under the same write dir the **Injecting the bridge** guide describes.
- **Large tables:** add your own `LIMIT`/`WHERE` to a query to narrow results below the cap and target exactly the rows you want.
