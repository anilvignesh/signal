---
name: inventory-adapter-clickup
description: Tracker adapter for the inventory agent. Lists the docs and tickets on a topic through ClickUp's REST API, read-only, using a key from the environment. Use when the inventory agent needs to scan the tracker for existing work.
---

# inventory-adapter-clickup

Optional add-on. Used by the inventory agent to fill `.pm/existing.md` with what already exists in the tracker. It only reads.

## Briefing

You get a topic (a few words), the workspace id, and the name of the environment variable that holds the API key (from `.pm/refs.json` or the setup answers). If the variable is missing or empty, stop and say so. Print its length only, never the value.

## Process

1. Cheap read first: `GET /api/v2/team` with header `Authorization: $KEY`. If it fails, stop and report the status code.
2. Tickets: `GET /api/v2/team/{workspace_id}/task?page=0&include_closed=true` and walk `page=1,2,...` until a page returns fewer than 100 tasks. Match the topic against name and description. Do not rely on one page.
3. Docs: `GET /api/v3/workspaces/{workspace_id}/docs` and follow the `next_cursor` until it is empty. Match the topic against the doc name. For each hit, list its pages and read page names only.
4. Keep for each hit: link, title, type (doc or ticket), date, owner, status.
5. Return rows for the Link, Title, Type, Date and Owner columns. The inventory agent adds Relation and Note.

## Rules

- Read-only. Use GET only. Never create, edit, move or delete anything.
- Never print or log the key. Never write it to a file.
- Rate limit: about 100 requests a minute per token. After each call, read the `X-RateLimit-Remaining` header. If it is under 5, or you get status 429, wait until `X-RateLimit-Reset` and then continue. After two 429s in a row, stop and report what you have so far.
- Say how many pages you walked and whether the walk was complete. A partial walk is reported as partial.
- Search the topic under its synonyms too, not only the exact words.

## Debrief

End with the standard debrief block.

```markdown
## Debrief — inventory-adapter-clickup
**Artifact:** none
**Digest:** {one line: how many docs and tickets matched, walk complete or partial}
**Learned:**
- {each matched item, e.g. "Doc X covers Y [source: tracker: <url>]"}
**Terms:** none
**Assumptions (proposals):** none
**Open questions for user:**
- {each, or `none`}
**Suggested next:** {single next step}
```
