# Snapshot (`accessibility_snapshot`)

- **Format:** a `# {header}` line, then `ref role "name" key=json... flags`. Header keys: `url`, `title`, `ready`, `count`, `focus`, `dialogs`, `matched` (with `query`), `form`, `iframes`, `behind`. `query` tests lines without refs; `max` caps rows. Past `max`, focus, dialogs and fields come first (`omitted`). Refs continue a per-document counter.
- **Blocking modal:** a modal `<dialog>`, or aria-modal over an inert or aria-hidden background, prints only its rows and live ones; `behind` counts the rest.
- **Nav:** a nav of 12+ shown links and nothing else is one `navigation` row, `links={ref: name}`.
- Neither applies with `role`/`query`.
- **Visibility:** `vis()` plus `snapVis` (a styled radio, checkbox or combobox shows when its label or box does).
- **Values:** a select's `value` is its chosen option's text; a placeholder choice (`nothingChosen`) has none and counts as required-empty. A combobox's `value` falls back to its box's value or chips.
- **`form` header** (the biggest visible form, across walked frames): `fields`, `requiredEmpty`, `invalid?`, `unpicked?`, `step?`. The census (`CENSUS_LIB`'s `census`, shared with `fill {fields}`) counts required-empty text fields, selects, comboboxes, checkboxes, radio groups and file inputs, skipping disabled ones.
- **Flags:** `invalid` plus `error="..."` (from `aria-invalid` or a native constraint failure; an empty required field stays in `requiredEmpty` instead), `unpicked` (a typeahead with typed text and no pick), `hidden` (a required-empty field `snapVis` drops gets a row after the ordinary rows; fill it by `ref`), with `reveal=<ref>` naming the button that likely shows it. Traps get no rows, nor do stand-ins (`standIn`: a text field aria-hidden and out of the tab order, such as react-select's required input), which the census skips too.
- **Embedded frames:** `iframes: [{src, w, h, same, in?}]` lists up to 5 visible iframes of 200x150 CSS px or more, largest first (`src`: origin and path). Same-origin ones are walked after the page's rows, each ending ` frame=<index>`. Cross-origin frames are only named.
- **`frames:true`** adds cross-origin frame controls from Accessibility as `fN` rows (see Frames). Otherwise no Accessibility work.
- Pinned by `test/snapshot-*.test.mjs`.
