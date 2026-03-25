# Scalable Selectors

Use this pattern for any `Popover + Command` or combobox-style selector whose backing data can grow with the organization.

This applies to issues, members, projects, teams, documents, roles, and similar dynamic entities.

## Default Behavior

- Before the user types, show up to 5 recent related results.
- Once the user types, switch to server-backed search.
- Keep the visible result list capped at 5 items.
- Use `Command` with `shouldFilter={false}` when the server already returns the filtered list.

The goal is to keep popovers fast and stable even when the organization has thousands of rows.

## Related First

When there is obvious context, use it:

- issue parent picker: prefer same project, then same team, then org-wide fallbacks
- project/member selectors: prefer current project members or recent collaborators
- document linkers: prefer nearby or recently touched documents

Do not start with an org-wide dump if the current surface already tells you what is related.

## UX Rules

- Do not render `Loading...` text. Use 5 skeleton rows that match the final item density.
- Keep the existing selected value visible on the trigger even if it is not in the current 5 results.
- For mutating selectors, keep using `useOptimisticValue` so the trigger updates immediately.
- Inline selectors should feel instant; the small result set is part of that.

## Anti-Pattern

Do not do this for dynamic data:

- fetch the entire org collection
- pass every row into `Command`
- rely on client-side filtering alone

That shifts scaling pressure into the client and makes the popover slower as the workspace grows.
