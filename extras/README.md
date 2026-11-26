# Extras

Optional add-ons. Signal works fully without them. They are off by default.

An add-on is a folder `extras/<name>/` with a `SKILL.md`. Add-ons may connect to outside tools. They are not part of the registry.

## Install

```
sh scripts/install.sh --with-extras
```

This links each add-on into `~/.claude/skills/<name>`. A plain `sh scripts/install.sh` installs none. Restart Claude Code after installing.

## Remove

```
sh scripts/install.sh --uninstall
```

This removes the add-on links with the rest of Signal. Real files and folders are never touched.

## Safety

An add-on acts on an outside account only after you say an explicit yes.

## Add-ons

- `publish-clickup`: publishes a frozen PRD to ClickUp as one Backlog ticket.
- `inventory-adapter-clickup`: lets the inventory agent list existing docs and tickets on a topic from ClickUp. Read-only. Needs an API key in an environment variable.
