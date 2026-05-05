# YoBoards Roadmap

This plan is based on the requests in `Changes.txt` and the current YoBoards codebase.

## Current state

- Lists currently ship with these built-in tabs: Wish List, NPC, Sell, Hair, Sets, PDE/Slots, Furns, Buy, Price Check, Fantasy.
- Custom tabs already exist and are stored in settings/state.
- Export PNG already supports custom tabs when they are present.
- Sync settings already track `customTabs`, `tabOrder`, and `hiddenTabs`.
- There is no real test harness in the repo yet.
- I did not find a user-facing backup/import-export flow for list data yet, so "export data feature in settings" still needs to be defined or built.

## Primary objective

Reshape YoBoards Lists around the requested tab model, make list/export/backup behavior consistent for both built-in and custom tabs, guarantee last-known-state persistence for user changes, then harden the product for release.

## Persistence requirement

- [x] Treat list-changing user actions in Lists as durable state changes.
- [x] Ensure user-created custom tabs remain available after popup close, sidepanel close, browser restart, and extension reload.
- [x] Ensure items added to built-in tabs and custom tabs persist in the last known saved state.
- [x] Ensure tab order, hidden tabs, notes, and related list metadata restore correctly on next launch.
- [x] Define when writes happen so users do not lose changes during normal use.

### Persistence acceptance criteria

- [x] If a user creates a custom tab, it is still there the next time they open the extension.
- [x] If a user adds items to that custom tab, those items are still there the next time they open the extension.
- [x] If a user reorders or hides tabs, the same layout returns on next launch.
- [x] If Chrome or the extension is restarted, the last successfully saved state is restored without manual recovery.

## Phase 1: lock the tab model

- [x] Confirm the final built-in tab set and labels:
  - General
  - Hair
  - Hats
  - HHs
  - PDE
  - Slots
  - Zynga
  - Furns
  - NPCs
  - PC
  - WL
  - WTB
- [x] Decide how existing tabs map into the new set.
- [x] Identify which current tabs are deprecated and what happens to their stored items.
- [x] Write a migration table before editing code.

### Required migration decisions

- [x] `wish` likely becomes `wl`.
- [x] `buy` likely becomes `wtb`.
- [x] `pricecheck` likely becomes `pc`.
- [x] `pdeSlots` must be split into separate `pde` and `slots` lists.
- [x] Decide whether `sell`, `sellSets`, and `fantasy` map into `general`, `zynga`, `hats`, `hhs`, or should be retired.
- [x] Decide whether `npc` should stay as `npc` internally or be renamed to `npcs` everywhere.

## Phase 2: refactor list architecture

- [x] Replace the hard-coded built-in tab list in the popup logic with the approved tab definitions.
- [x] Update the default state object so every built-in list exists from first launch.
- [x] Update section filter state so it matches the final tab set.
- [x] Update the Add Item section dropdown to use the new tab definitions.
- [x] Update built-in HTML panels or generate them from config to reduce duplication.
- [x] Remove orphaned UI/actions for discarded tabs.
- [x] Add a one-time state migration so existing users do not lose data.
- [x] Audit every list-changing workflow so changes are saved immediately or on a clearly defined safe trigger.
- [x] Verify custom tab creation, item add/remove, and tab management all write to persistent storage reliably.

### Files likely involved

- [x] `popup.js`
- [x] `popup.html`
- [x] `popup.css`

## Phase 3: export and backup parity

- [x] Audit every export path so all built-in tabs and all custom tabs are treated consistently.
- [x] Confirm export scope labels reflect the new names.
- [x] Ensure custom tabs are included in any backup/export payload, not just PNG export.
- [x] Add a proper data backup flow in Settings if that feature does not already exist.
- [x] Add a matching restore/import flow with validation.
- [x] Version the backup schema so future tab changes are recoverable.
- [x] Define recovery behavior if local and sync state drift from each other.

### Acceptance criteria

- [ ] Built-in tabs export correctly after the rename/split work.
- [x] A user-created tab appears in export scope controls automatically.
- [x] A user-created tab and its items survive normal extension reopen/reload behavior.
- [ ] A backup created on one machine restores correctly on another machine.
- [ ] Hidden tabs and tab order survive backup/restore.

## Phase 4: testing and bug coverage

- [x] Choose a lightweight browser-extension-friendly test setup.
- [x] Start with pure-function coverage before DOM-heavy tests.
- [x] Add tests for tab migration logic.
- [ ] Add tests for custom tab serialization/deserialization.
- [ ] Add tests for last-known-state save and reload behavior.
- [ ] Add tests for export scope generation.
- [ ] Add tests for backup payload creation and restore validation.
- [ ] Add smoke tests for tab creation, deletion, hide, and restore flows.
- [ ] Run manual regression testing in Chrome for popup and side panel.

### Good first test targets

- [ ] `defaultState()`
- [x] tab migration helper
- [ ] `getTabsFullOrder()`
- [ ] `getEffectiveTabOrder()`
- [ ] save/load state helpers
- [ ] `exportSectionsForScope()`
- [ ] backup/import validators

## Phase 5: release-quality UI polish

- [ ] Tighten the information hierarchy in the Lists module.
- [ ] Reduce visual clutter in the export controls and tab management UI.
- [ ] Improve spacing, typography, and button consistency.
- [ ] Make custom-tab management feel intentional instead of utility-only.
- [ ] Review popup vs sidepanel layout behavior on smaller widths.
- [ ] Add a short onboarding/help cue for export, custom tabs, and backup.

## Phase 6: security reality check

- [ ] Treat this as deterrence, not true protection.
- [ ] Minify/obfuscate release assets if desired.
- [ ] Remove debug leftovers and unnecessary exposed internals.
- [ ] Move any sensitive licensing or entitlement checks off-client.

### Important note

- [ ] A Chrome extension cannot fully prevent users from extracting client-side code.
- [ ] Real protection only exists when valuable logic or paid entitlements are enforced by a server you control.

## Phase 7: payments and licensing

- [ ] Define the sales model first: one-time payment, account-based license, or key-based activation.
- [ ] Decide whether payment is handled off-platform or through an external storefront.
- [ ] Build a simple license service before wiring payment into the extension.
- [ ] Gate premium features through server-validated entitlements.
- [ ] Add account recovery/update handling for lifetime purchasers.

## Recommended execution order

- [x] 1. Finalize the tab mapping and migration rules.
- [x] 2. Refactor list definitions so built-in tabs come from one source of truth.
- [ ] 3. Add backup/import support and make export parity explicit.
- [ ] 4. Add tests around migration, tab state, and export behavior.
- [ ] 5. Polish UI after the data model stabilizes.
- [ ] 6. Add monetization/licensing last.

## Immediate next implementation slice

- [x] Create the final old-to-new tab mapping table.
- [x] Refactor built-in tab definitions into one shared config.
- [ ] Split `pdeSlots` into `pde` and `slots` with migration logic.
- [x] Audit save triggers for custom tabs and list item mutations.
- [x] Rename export scope labels and add backup/import requirements.
- [x] Add the first test file for migration and tab-order helpers.