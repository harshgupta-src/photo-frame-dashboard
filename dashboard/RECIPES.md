# Recipes tab

The Recipes tab shows the recipe notes from the Obsidian vault (`Areas/Hobbies/Recipes/`) on the
iPhone and iPad. The frame never shows it: when the kiosk's `window.HomeHQ` bridge is present,
`js/views/recipes.js` removes the tab button and doesn't register the view.

## How it gets the notes

```
phone/iPad ──GET /recipes (X-Frame-Key)──▶ frame-data Worker ──MCP vault_list / vault_read──▶ Home Brain gateway ──▶ vault
```

- The Worker (`worker/src/recipes.js`) calls the Home Brain gateway's stateless MCP endpoint with
  the `frame-recipes` token. That token can only call `vault_list` and `vault_read`, and only under
  `Areas/Hobbies/Recipes`. Anything else is refused and audited as `denied`. It's defined in
  `home-brain-gateway/scripts/make-config.sh` (from `GATEWAY_TOKEN_FRAME_RECIPES`).
- The Worker splits each note into title, summary, `updated` date and `##` sections, sorts them by
  `updated` (newest first), and caches the result in KV for 10 minutes. The tab's refresh button
  sends `?refresh=1`, which reads the vault immediately (at most once every 15 s). If the gateway is
  down, the Worker serves the last cached copy marked `stale`.
- The app keeps its own copy in localStorage, so recipes still open offline.

Worker secrets (in `.env.local`; `npm run deploy` uploads them):

| Name              | Value                                                         |
| ----------------- | ------------------------------------------------------------- |
| `VAULT_MCP_URL`   | Gateway MCP URL, e.g. `https://<gateway host>/mcp`            |
| `VAULT_MCP_TOKEN` | The gateway's `frame-recipes` token                           |
| `RECIPES_PATH`    | Optional vault folder (default `Areas/Hobbies/Recipes`)       |

Without the first two, `/recipes` returns 503 and the tab shows that error.

## In the tab

- Search across titles, summaries and ingredients.
- iPad: list and recipe side by side (in landscape). Phone: list, then the recipe with a back button.
- Tap an ingredient to tick it off; tap a method step to mark where you are.
- The screen stays on while a recipe is open (Screen Wake Lock), and the iPad doesn't idle back to
  Today mid-recipe (views registered with `stay: true` are skipped by the idle timer).
- Links to other recipes (`[[Toum]]`) open that recipe; the History section is folded away and the
  vault's `_(YYYY-MM-DD)_` fact dates are hidden.

## Adding recipes

Save a note in `Areas/Hobbies/Recipes/` with the usual recipe shape: a `# Title`, a `>` summary
line, then `## Key facts`, `## Recipe` (`###` groups for ingredients, `### Method` as a numbered
list), `## Variations` and `## History`. It appears within 10 minutes, or straight away with refresh.

## Rotating the token

1. Put a new random value in `GATEWAY_TOKEN_FRAME_RECIPES` (`~/.config/homehq/gateway.env`) and
   redeploy the gateway config (`home-brain-gateway/deploy/deploy.sh --config`).
2. Set the same value as `VAULT_MCP_TOKEN` in `.env.local` and run `npm run deploy`.
