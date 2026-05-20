// Zen Tab Wand — browser-context event hooks.
//
// Rule growth is now strictly user-initiated:
//   • Settings UI — direct editing of each rule's domain list.
//   • Tab right-click → "Add <hostname> to <group> rule" — explicit menu item
//     installed by setupTabContextMenu (this file).
//
// We REMOVED the previous global TabGrouped listener because Zen dispatches
// TabGrouped events asynchronously (and for non-user reasons like session
// restore reconciling state after we've programmatically ejected a tab).
// There's no reliable way to distinguish user-initiated grouping from Zen's
// internal re-attaches, so the listener was an endless source of phantom
// rule growth. The context menu item replaces it with explicit user intent.
//
// Remaining DOM hook + observer in this file:
//   TabGroupCreate   — re-apply rule colors when Zen restores groups on startup.
//   minimal-style    — re-run syncAllGroupColors when the user toggles the pref.
//
// On DOM hooks we stash the installed handler back onto its host element as a
// `_zaoXxxHook` expando. This prevents double-install if the entry script is
// re-evaluated (e.g. across module reloads during development).

import { CONFIG, LOG, BUILD_VERSION, isZenColorName, isUnsetLabel } from "./config.mjs";
import { getTabUrl, getHostname } from "./tabs.mjs";
import { readRulesPref, writeRulesPref, readSkipDomainsPref, writeSkipDomainsPref, isMinimalStyle } from "./rules.mjs";
import { applyGroupColor, syncAllGroupColors } from "./groups.mjs";

// No-op shims for back-compat. The TabGrouped listener is gone, so there's
// nothing to suppress. These exports stay so existing callsites in pass1.mjs /
// ai.mjs / groups.mjs / click-handler.mjs don't need touching; they can be
// cleaned up in a future sweep.
export const pushTabGroupedHookSuppression = () => {};
export const popTabGroupedHookSuppression = () => {};
export const setTabGroupedHookSuppressed = (_val) => {};
export const markTabAsEjected = (_tab) => {};

// ─── Helpers (module level so they're reusable + easy to find) ───────────────

// Add the tab's hostname to an existing rule, or create a new rule if the group
// name isn't in the rules yet. Called from both the named-group and new-group paths.
const applyToRule = (tab, groupName, group) => {
  const hostname = getHostname(getTabUrl(tab));
  if (!hostname) return;

  const rules = readRulesPref() || [];
  const rule = rules.find((r) => r.name === groupName);

  if (rule) {
    if (rule.domains.includes(hostname)) {
      console.log(`${LOG} context-menu: "${hostname}" already in "${groupName}"`);
      return;
    }
    rule.domains.push(hostname);
    writeRulesPref(rules);
    console.log(`${LOG} context-menu: added "${hostname}" to existing rule "${groupName}"`);
  } else {
    const newRule = { name: groupName, domains: [hostname] };
    const groupColor = group?.color;
    if (isZenColorName(groupColor)) newRule.color = groupColor;
    rules.push(newRule);
    writeRulesPref(rules);
    console.log(
      `${LOG} context-menu: created new rule "${groupName}" with "${hostname}"` +
        (newRule.color ? ` (color: ${newRule.color})` : "")
    );
  }
};

// ─── Setup ───────────────────────────────────────────────────────────────────

// Install a tab right-click submenu `Add "<hostname>" to Rule…` that lists
// every current rule as a child menuitem. User picks a rule → the hostname is
// added to that rule's domains. The current group is irrelevant — this lets
// the user grow ANY rule for the hostname, not just the rule matching the
// tab's existing group.
//
// Replaces the previous global TabGrouped listener (which couldn't reliably
// distinguish user actions from Zen's async session-restore re-attaches) with
// an explicit user-driven flow: no events, no race conditions.
const PARENT_MENU_ID = "zen-tab-wand-add-to-rule-menu";

const findContextMenu = () =>
  document.getElementById("tabContextMenu") ||
  document.getElementById("zenTabContextMenu") ||
  null;

const getTabHostname = (tab) => {
  if (!tab) return null;
  try { return getHostname(getTabUrl(tab)); } catch { return null; }
};

export const setupTabContextMenu = () => {
  const menu = findContextMenu();
  if (!menu) {
    console.warn(`${LOG} tab context menu not found — context menu integration skipped`);
    return;
  }
  if (menu._zaoContextMenuInstalled) return;

  // Build the submenu skeleton. Submenu items are rebuilt each popupshowing
  // so rule edits in settings are immediately reflected.
  const parent = document.createXULElement("menu");
  parent.id = PARENT_MENU_ID;
  parent.setAttribute("label", "Add to Rule…");
  parent.setAttribute("hidden", "true");

  const popup = document.createXULElement("menupopup");
  parent.appendChild(popup);
  menu.appendChild(parent);

  // Captured on the outer popupshowing and read by the inner command handler.
  let currentTab = null;
  let currentHostname = null;

  const onOuterShowing = (e) => {
    // Only react to the outer (tab) context menu opening — submenu popupshowing
    // also bubbles through here.
    if (e.target !== menu) return;
    currentTab = window.TabContextMenu?.contextTab || window.gBrowser?.selectedTab;
    currentHostname = getTabHostname(currentTab);
    if (!currentTab || !currentHostname) {
      parent.hidden = true;
      return;
    }
    parent.hidden = false;
    parent.setAttribute("label", `Add "${currentHostname}" to Rule…`);
  };

  const onSubmenuShowing = () => {
    while (popup.firstChild) popup.firstChild.remove();
    const rules = readRulesPref() || [];
    const skipList = readSkipDomainsPref() || [];
    if (rules.length === 0) {
      const placeholder = document.createXULElement("menuitem");
      placeholder.setAttribute("label", "(no rules defined yet)");
      placeholder.setAttribute("disabled", "true");
      popup.appendChild(placeholder);
    } else {
      for (const rule of rules) {
        const item = document.createXULElement("menuitem");
        const inRule = currentHostname && rule.domains.includes(currentHostname);
        // Checkmark for rules that already contain this hostname (disabled
        // to make it clear the action is a no-op).
        item.setAttribute("label", inRule ? `✓ ${rule.name}` : rule.name);
        if (inRule) item.setAttribute("disabled", "true");
        item.dataset.zaoRuleName = rule.name;
        popup.appendChild(item);
      }
    }

    // Skip-domains entry: a distinct "destination" for the hostname (parks
    // the tab at the top of the workspace on every tidy click instead of
    // grouping it). Separated from rules with a menuseparator. Shows ✓ +
    // disabled if the hostname is already in the skip list.
    popup.appendChild(document.createXULElement("menuseparator"));
    const skipItem = document.createXULElement("menuitem");
    const inSkip = currentHostname && skipList.includes(currentHostname);
    skipItem.setAttribute("label", inSkip ? "✓ Skip" : "Skip");
    if (inSkip) skipItem.setAttribute("disabled", "true");
    skipItem.dataset.zaoSkip = "true";
    popup.appendChild(skipItem);
  };

  const onCommand = (e) => {
    const item = e.target;
    if (!currentTab || !currentHostname) return;
    if (item?.dataset?.zaoSkip === "true") {
      const skipList = readSkipDomainsPref() || [];
      if (skipList.includes(currentHostname)) return;
      skipList.push(currentHostname);
      writeSkipDomainsPref(skipList);
      console.log(`${LOG} context-menu: added "${currentHostname}" to skip-domains`);
      return;
    }
    const ruleName = item?.dataset?.zaoRuleName;
    if (!ruleName) return;
    // applyToRule reads the hostname off the tab itself; pass the tab's
    // current group element so its color is preserved if applyToRule has to
    // create a new rule (defensive — the submenu only lists existing rules,
    // but applyToRule is safe either way).
    const groupEl = currentTab.closest?.("tab-group");
    applyToRule(currentTab, ruleName, groupEl);
  };

  menu.addEventListener("popupshowing", onOuterShowing);
  popup.addEventListener("popupshowing", onSubmenuShowing);
  popup.addEventListener("command", onCommand);
  menu._zaoContextMenuInstalled = { onOuterShowing, onSubmenuShowing, onCommand, parent, popup };
  console.log(`${LOG} tab context submenu installed (build ${BUILD_VERSION})`);
};

export const teardownTabContextMenu = () => {
  const menu = findContextMenu();
  if (!menu?._zaoContextMenuInstalled) return;
  const { onOuterShowing, onSubmenuShowing, onCommand, parent, popup } = menu._zaoContextMenuInstalled;
  try { menu.removeEventListener("popupshowing", onOuterShowing); } catch {}
  try { popup.removeEventListener("popupshowing", onSubmenuShowing); } catch {}
  try { popup.removeEventListener("command", onCommand); } catch {}
  if (parent?.isConnected) try { parent.remove(); } catch {}
  menu._zaoContextMenuInstalled = null;
};

// On every tab-group creation (including session restore on startup), re-apply the
// rule's color so it survives across browser restarts even if Zen's session storage
// dropped our previously-set color.
export const setupTabGroupCreateHook = () => {
  if (typeof gBrowser === "undefined" || !gBrowser.tabContainer) return;
  if (gBrowser.tabContainer._zaoTabGroupCreateHook) return;

  const handler = (event) => {
    try {
      const group = event.target;
      if (!group?.isConnected) return;
      const label = group.getAttribute?.("label");
      if (!label) return;

      const rules = readRulesPref() || [];
      const rule = rules.find((r) => r.name === label);
      if (!rule?.color) return;

      // Defer one tick so Zen's own color setup (which runs synchronously during
      // group construction) is done before we override.
      setTimeout(() => {
        if (group.isConnected) applyGroupColor(group, rule.color);
      }, 0);
    } catch (e) {
      console.error(`${LOG} TabGroupCreate handler error:`, e);
    }
  };

  gBrowser.tabContainer.addEventListener("TabGroupCreate", handler);
  gBrowser.tabContainer._zaoTabGroupCreateHook = handler;
  console.log(`${LOG} TabGroupCreate hook installed`);
};

// ─── Pref observers ──────────────────────────────────────────────────────────

// Live re-apply of group styling when the user toggles the minimal-style pref.
// Without this the change is invisible until the next tidy-click.
//
// Services.prefs.addObserver attaches to the *global* prefs service (lives in the
// parent process) and would survive window close, leaking a window reference if
// we don't remove it. Hence the explicit teardown — wired into the entry
// script's cleanup() handler.
let minimalStylePrefObserver = null;

export const setupMinimalStylePrefObserver = () => {
  if (minimalStylePrefObserver) return;
  minimalStylePrefObserver = {
    observe(_subject, topic, data) {
      if (topic !== "nsPref:changed") return;
      if (data !== CONFIG.MINIMAL_STYLE_PREF) return;
      try {
        // Pass null so we walk every workspace's tab-groups — minimal-style is a
        // global pref and a user toggling it expects the change to apply everywhere,
        // not just whichever workspace happens to be active at the moment.
        const rules = readRulesPref() || [];
        const touched = syncAllGroupColors(null, rules);
        console.log(`${LOG} minimal-style toggled → resynced ${touched} group(s) across all workspaces (minimal=${isMinimalStyle()})`);
      } catch (e) {
        console.error(`${LOG} minimal-style pref observer error:`, e);
      }
    },
  };
  Services.prefs.addObserver(CONFIG.MINIMAL_STYLE_PREF, minimalStylePrefObserver);
  console.log(`${LOG} minimal-style pref observer installed`);
};

export const teardownMinimalStylePrefObserver = () => {
  if (!minimalStylePrefObserver) return;
  try {
    Services.prefs.removeObserver(CONFIG.MINIMAL_STYLE_PREF, minimalStylePrefObserver);
  } catch (e) {
    console.warn(`${LOG} failed to remove minimal-style pref observer:`, e);
  }
  minimalStylePrefObserver = null;
};
