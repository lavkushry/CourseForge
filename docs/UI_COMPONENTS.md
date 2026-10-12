# Shared UI components

Every focusable control receives one `data-ui-component` from the existing semantics and action. `components.js` applies this mapping on initial render and on added DOM nodes; it does not replace listeners, change requests, or modify player ownership. Existing classes remain structural and behavior hooks.

| Component | Variants | Contract |
| --- | --- | --- |
| Button | primary, secondary, ghost, icon | 44 px minimum target; shared font, padding, radius, focus, hover and disabled states |
| Input | text, multiline | 44 px control; 120 px minimum textarea; 16 px font on phones |
| Select | list, checkable, range | Native selection semantics; checkbox/radio labels preserve the touch target; media ranges preserve their behavior |
| Card | panel, media | Shared border, radius, surface and elevation; media cards have an unpadded image region |
| Chip | panel, action | Shared badge shape and typography; interactive source chips have 44 px targets |
| Row | default | Clickable lessons, transcripts, saved paths and search results have visible row boundaries |
| Modal | panel | Shared surface, border, elevation and backdrop; viewport bounds and reachable close controls |
| Tab | navigation, section | One selected, hover and focus treatment for navigation and filters |

Sign in uses the primary button. Refresh, Reload and Retry use secondary buttons, including the historical text-link controls. Download uses the secondary button in the materials browser and lesson panels. Notes and bookmarks use the same ghost action treatment for timestamps and delete actions. Selection controls keep their native input types and accessible names.

`tokens.css` owns the palettes, typography, spacing, radii, dimensions and semantic aliases. Spacing uses the 4 px grid. Borders and preserved watermark geometry are explicit exceptions to that spacing scale. Artwork colors and measured progress are data. Artwork URLs and progress percentages are the only permitted inline template styles.

CSS layers give components precedence over placement and older view rules: tokens, base, layout, components. Component display defaults have zero specificity in the base layer so responsive visibility rules remain effective. View rules place controls; shared classes determine their presentation. The cleanup removes 216 obsolete declarations and duplicate theme definitions. The icon sprite is unchanged; rendered icons use 16, 20 or 24 px with a single stroke weight. Native media controls use the same sprite through their supported icon slots. Legacy hover transforms have been removed so controls keep a stable position under the pointer, including focus Start/Pause transitions on phones.

Player geometry remains responsive. The player controller and its keyboard-focusable stage map to media cards; they are not buttons. The player security and event scripts, authentication, vault delivery and ownership implementations have no changes relative to the current production branch.
