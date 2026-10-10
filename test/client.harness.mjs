// Standalone harness for dsh-client-ui-model-favorites/lib/client.js.
// Loads the real bundle through a fake __ModuleLoader__ + fake store engine,
// then drives the plugin's data-layer decoration and /model-favorites command.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const registration = { current: null };
globalThis.window = {
	__ModuleLoader__: { load: (reg) => { registration.current = reg; } },
	addEventListener: () => {}
};

/** Minimal stand-in for @deepseek-ai/dsh-client-store's engine. */
function createSnapshotStore(init) {
	const listeners = new Set();
	let state = init;
	const notify = () => { for (const fn of [...listeners]) fn(); };
	return {
		getSnapshot: () => state,
		subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
		update: (mutator) => {
			const draft = JSON.parse(JSON.stringify(state));
			mutator(draft);
			state = draft;
			notify();
		},
		set: (next) => {
			state = next;
			notify();
		}
	};
}

const requireShim = (spec) => {
	if (spec === "@deepseek-ai/dsh-client-store") return { createSnapshotStore };
	if (spec === "@deepseek-ai/dsh-client-ui-primitives") return { Button: () => null, IconPinFillRegular: () => null };
	if (spec === "react") return {
		createElement: (type, props, ...children) => ({ type, props, children }),
		useSyncExternalStore: () => 0
	};
	throw new Error(`unexpected require("${spec}")`);
};

const registered = [];
const invoked = [];
const commandUi = {
	register(contribution) {
		registered.push(contribution);
		return () => {};
	},
	invoke(name, ui, session, segment) {
		invoked.push({ name, ui, session, segment });
		return void 0;
	}
};

const realStore = createSnapshotStore({
	current: { provider: "p1", model: "m1" },
	routable: true,
	groups: [
		{ id: "p1", name: "Provider One", models: [{ id: "m1", name: "Alpha" }, { id: "m2", name: "Beta" }] },
		{ id: "p2", name: "Provider Two", models: [{ id: "m3", name: "Gamma" }] }
	],
	failures: [],
	status: "ready",
	pending: null,
	error: null
});

const selections = [];
const directory = {
	store: realStore,
	load: async () => realStore.getSnapshot(),
	select: async (selection) => {
		selections.push(selection);
		return { ok: true };
	},
	dispose() {}
};
const resolver = {
	live: { directories: { values: new Set([directory]) } },
	directoryFor: () => directory
};

const dictionaries = new Map();
const slotSeats = [];
const slots = {
	inject(key, callback) {
		const disposer = callback();
		slotSeats.push({ key, disposer });
		return () => {};
	},
	register(options, component) {
		return { options, component };
	}
};
let subagentAddressed = false;
const ctx = {
	effect: (fn) => { fn(); },
	locale: {
		register: (ns, dicts) => { dictionaries.set(ns, dicts); return () => {}; },
		bind: (ns) => (key) => dictionaries.get(ns)?.zh?.[key] ?? key
	},
	inject: (deps, callback) => {
		callback({
			modelDirectories: resolver,
			sessions: { subagentAddress: () => (subagentAddressed ? "addr" : void 0) },
			get: (name) => (name === "commandUi" ? commandUi : void 0),
			slots,
			effect: (fn) => { fn(); }
		});
	}
};

const assertions = [];
const check = (label, condition, extra) => {
	assertions.push({ label, ok: condition === true, extra });
	if (condition !== true) console.error(`FAIL: ${label}`, extra === void 0 ? "" : JSON.stringify(extra));
};

const clientPath = process.argv[2] ?? "./lib/client.js";
const clientUrl = pathToFileURL(resolve(clientPath)).href;
await import(clientUrl);
check("bundle registered its module id", registration.current?.id === "dsh-client-ui-model-favorites", registration.current?.id);
const mod = registration.current.factory(requireShim);
check("exports apply", typeof mod.apply === "function");
check("exports inject gates on the directory service only", JSON.stringify(mod.inject) === JSON.stringify(["modelDirectories"]), mod.inject);

mod.apply(ctx);
check("both management commands registered", registered.length === 2 && registered[0]?.name === "model-favorites" && registered[1]?.name === "model-pins", registered.map((contribution) => contribution.name));

// The composer toolbar trigger plus the root-overlay row context menu.
const seat = slotSeats.find((entry) => entry.disposer?.options?.id === "model-favorites-trigger")?.disposer;
const menuSeat = slotSeats.find((entry) => entry.disposer?.options?.id === "model-favorites-context-menu")?.disposer;
check("trigger seat contributed", slotSeats.some((entry) => entry.key === "conversation.input.left"), slotSeats.map((entry) => entry.key));
check("trigger id and order", seat?.options.id === "model-favorites-trigger" && seat?.options.order === 50 && seat?.options.name === "conversation.input.left", seat?.options);
check("context menu seat rides the root overlay", menuSeat?.options.name === "shell.overlay" && menuSeat?.options.id === "model-favorites-context-menu", menuSeat?.options);
const face = seat.options.inject("session-1");
check("trigger inject face for a regular session", face.sessionId === "session-1" && face.available === true, face);
subagentAddressed = true;
const faceSub = seat.options.inject("session-9");
subagentAddressed = false;
check("trigger inject face hides for subagents", faceSub.available === false, faceSub);
const rendered = seat.component(face);
check("trigger renders the pin button", rendered !== null && typeof rendered.props.onClick === "function", rendered);
check("trigger button carries the readable label", JSON.stringify(rendered.children) === JSON.stringify(["收藏"]) && rendered.props["aria-label"] === "收藏置顶", rendered.children);
check("trigger renders nothing for subagents", seat.component(faceSub) === null);
rendered.props.onClick();
check("trigger opens the favorites popup through commandUi.invoke", invoked.length === 1 && invoked[0].name === "model-favorites" && invoked[0].session.sessionId === "session-1" && invoked[0].segment.via === "enter" && invoked[0].segment.token === "/model-favorites", invoked[0]);
check("trigger reuses the registered popup spec", invoked[0]?.ui === registered[0].ui);

// The core plugin resolves directories through the same service method.
const served = resolver.directoryFor("session-1");
check("served directory is the decorated instance", served === directory);

let notifications = 0;
served.store.subscribe(() => { notifications += 1; });

const before = served.store.getSnapshot();
check("with neither list the raw snapshot identity is preserved", before === realStore.getSnapshot());

const options = await registered[0].ui.options({ sessionId: "session-1" });
check("options list every model and hide the clear row while empty", options.length === 3, options.map((row) => row.id));
check("options carry provider/model ids", options[0].id === "p1/m1" && options[1].id === "p1/m2" && options[2].id === "p2/m3", options.map((row) => row.id));
check("options mark the current model", options[0].detail === dictionaries.get("modelFavorites").zh["option.current"], options[0].detail);
check("options keep provider group labels", options[0].group.label === "Provider One", options[0].group);

// 收藏 Beta (p1/m2) through the favorites command, 置顶 Gamma (p2/m3) through the pins command.
await registered[0].ui.onSelect({ id: "p1/m2" });
await registered[1].ui.onSelect({ id: "p2/m3" });

const after = served.store.getSnapshot();
const favoritesGroup = after.groups[0];
check("the 收藏 group is inserted first", favoritesGroup.id === "dsh-model-favorites" && favoritesGroup.name === "收藏", { id: favoritesGroup.id, name: favoritesGroup.name });
check("the favorite row names its source provider", favoritesGroup.models[0]?.name === "Beta（来自 Provider One）", favoritesGroup.models.map((model) => model.name));
check("the favorite row carries the composite key as its model id", favoritesGroup.models[0]?.id === "p1/m2", favoritesGroup.models.map((model) => model.id));
const groupsAfter = after.groups.slice(1);
check("置顶 rises inside its own provider group", groupsAfter[1].id === "p2" && groupsAfter[1].models[0].id === "m3" && groupsAfter[0].models[0].id === "m1", groupsAfter.map((group) => ({ id: group.id, models: group.models.map((model) => model.id) })));
check("provider and model ids stay untouched below the synthetic group", groupsAfter[0].id === "p1" && groupsAfter[0].models[0].id === "m1", groupsAfter[0]);
check("favorite names keep no text marker", groupsAfter[0].models[1].name === "Beta", groupsAfter[0].models.map((model) => model.name));
check("unrelated snapshot fields are preserved", after.current.provider === "p1" && after.status === "ready" && Array.isArray(after.failures));
check("the real store is never mutated", realStore.getSnapshot().groups[0].models[1].name === "Beta" && realStore.getSnapshot().groups.length === 2);
check("subscribers were notified on list changes", notifications >= 2, notifications);
check("real store updates still reach the facade", (() => {
	realStore.update((draft) => { draft.status = "loading"; });
	return served.store.getSnapshot().status === "loading";
})());

// Selection: a row of the synthetic group must still select the real model.
const fromFavorites = await served.select({ provider: "dsh-model-favorites", model: "p1/m2" });
check("selecting a favorite row maps back to the real provider/model", selections.at(-1)?.provider === "p1" && selections.at(-1)?.model === "m2", selections.at(-1));
check("the remapped selection still returns the directory outcome", fromFavorites?.ok === true, fromFavorites);
await served.select({ provider: "p1", model: "m1" });
check("a plain provider/model selection passes through untouched", selections.at(-1)?.provider === "p1" && selections.at(-1)?.model === "m1", selections.at(-1));

// The management popups mark both lists.
const markedRows = await registered[0].ui.options({ sessionId: "session-1" });
check("the favorites popup marks the favorite and the pin", markedRows[1].detail === "★" && markedRows[2].detail === "置顶", markedRows.map((row) => ({ id: row.id, detail: row.detail })));
check("the favorites popup skips the synthetic group", markedRows.length === 4 && markedRows[0].group.name === "p1" && markedRows[3].id === "\u0000model-favorites:clear", markedRows.map((row) => row.id));
const pinRows = await registered[1].ui.options({ sessionId: "session-1" });
check("the pins popup offers its own clear row", pinRows.length === 4 && pinRows[3].id === "\u0000model-favorites:clear-pins" && pinRows[3].label === "清空全部置顶", pinRows.at(-1));

// Unfavorite Beta: the synthetic group disappears, the pin stays.
await registered[0].ui.onSelect({ id: "p1/m2" });
const withoutFavorites = served.store.getSnapshot();
check("unfavoriting drops the synthetic group", withoutFavorites.groups.every((group) => group.id !== "dsh-model-favorites") && withoutFavorites.groups.length === 2, withoutFavorites.groups.map((group) => group.id));
check("the pin survives the unfavorite", withoutFavorites.groups[1].models[0].id === "m3", withoutFavorites.groups[1].models.map((model) => model.id));

// Clear pins: back to the plain snapshot.
const clearPinRow = (await registered[1].ui.options({ sessionId: "session-1" })).at(-1);
await registered[1].ui.onSelect({ id: clearPinRow.id });
check("clearing pins returns the raw snapshot identity", served.store.getSnapshot() === realStore.getSnapshot());
check("clear rows disappear when empty", (await registered[1].ui.options({ sessionId: "session-1" })).length === 3, (await registered[1].ui.options({ sessionId: "session-1" })).length);

// A live window still stacks the store facades an earlier version installed, and
// those appended one star per layer. Normalization has to erase them without ever
// appending a marker of its own.
realStore.update((draft) => { draft.groups[0].models[0].name = "Alpha ☆ ☆ ☆ ☆"; });
const healed = served.store.getSnapshot();
check("stale star markers are normalized away", healed.groups[0].models[0].name === "Alpha" && healed.groups[1].models[0].name === "Gamma", healed.groups.map((group) => group.models.map((model) => model.name)));
realStore.update((draft) => { draft.groups[0].models[0].name = "Alpha"; });
check("a clean catalog keeps the raw snapshot identity", served.store.getSnapshot() === realStore.getSnapshot());

// dispose() tears the facade subscriptions down.
served.dispose();
const notificationsAtDispose = notifications;
await registered[0].ui.onSelect({ id: "p1/m1" });
check("no notifications after dispose", notifications === notificationsAtDispose, { notificationsAtDispose, notifications });

// ─── Phase 2: legacy-kernel degradation matrix ─────────────────────────────
// Each scenario re-runs the factory against a thinner kernel surface and
// asserts the plugin degrades instead of failing the whole plugin-table load.

function makeLegacyEnv({ reactOverrides = {}, primitives: prims, commandUi: cmd, withModels = true, withLocale = true, registerThrows = false } = {}) {
	const envRegistered = [];
	const envInvoked = [];
	const envSeats = [];
	const command = {
		register(contribution) {
			if (registerThrows) throw new Error("kernel refused the contribution");
			envRegistered.push(contribution);
			return () => {};
		},
		...(cmd?.invoke ? { invoke: (name, ui, session, segment) => { envInvoked.push({ name, ui, session, segment }); } } : {})
	};
	const legacyStore = createSnapshotStore({
		current: { provider: "p1", model: "m1" },
		routable: true,
		groups: [
			{ id: "p1", name: "Provider One", models: [{ id: "m1", name: "Alpha" }] },
			{ id: "p2", name: "Provider Two", models: [{ id: "m3", name: "Gamma" }] }
		],
		failures: [],
		status: "ready",
		pending: null,
		error: null
	});
	const dir = { store: legacyStore, load: async () => legacyStore.getSnapshot(), select: async () => ({ ok: true }), dispose() {} };
	const legacyResolver = { live: { directories: { values: new Set([dir]) } }, directoryFor: () => dir };
	const legacyCtx = {
		effect: (fn) => { fn(); },
		...(withLocale ? { locale: { register: (ns, dicts) => { dictionaries.set(ns, dicts); return () => {}; }, bind: (ns) => (key) => dictionaries.get(ns)?.zh?.[key] ?? key } } : {}),
		inject: (deps, callback) => {
			callback({
				...(withModels ? { modelDirectories: legacyResolver } : {}),
				sessions: { subagentAddress: () => void 0 },
				get: (name) => (name === "commandUi" ? command : void 0),
				slots: {
					inject: (key, cb) => { envSeats.push({ key, seat: cb() }); return () => {}; },
					register: (options, component) => ({ options, component })
				},
				effect: (fn) => { fn(); }
			});
		}
	};
	const shim = (spec) => {
		if (spec === "@deepseek-ai/dsh-client-store") return { createSnapshotStore };
		if (spec === "@deepseek-ai/dsh-client-ui-primitives") return prims ?? { Button: () => null, IconPinFillRegular: () => null };
		if (spec === "react") return {
			createElement: (type, props, ...children) => ({ type, props, children }),
			useSyncExternalStore: () => 0,
			...reactOverrides
		};
		throw new Error(`unexpected require("${spec}")`);
	};
	const legacyMod = registration.current.factory(shim);
	return { mod: legacyMod, legacyCtx, envRegistered, envInvoked, envSeats };
}

/** The composer toolbar seats only (the root-overlay menu seat rides every kernel). */
const triggerSeats = (envSeats) => envSeats.filter((entry) => entry.seat?.options?.id === "model-favorites-trigger");

// A: primitives without Button/icon — commands lose their icon, no trigger.
{
	const { mod, legacyCtx, envRegistered, envSeats } = makeLegacyEnv({ primitives: {} });
	let threw = false;
	try { mod.apply(legacyCtx); } catch (error) { threw = true; console.error(error); }
	check("legacy: missing primitives does not fail the load", threw === false);
	check("legacy: commands still register without an icon", envRegistered.length === 2 && envRegistered[0].icon === void 0 && envRegistered[1].name === "model-pins", envRegistered.map((contribution) => contribution.name));
	check("legacy: trigger skipped without icon primitives", triggerSeats(envSeats).length === 0, envSeats.length);
}

// B: no popup invocation path — command keeps working, no trigger.
{
	const { mod, legacyCtx, envRegistered, envSeats } = makeLegacyEnv({ commandUi: {} });
	let threw = false;
	try { mod.apply(legacyCtx); } catch (error) { threw = true; console.error(error); }
	check("legacy: missing commandUi.invoke does not fail the load", threw === false);
	check("legacy: commands keep their icon without invoke", envRegistered.length === 2 && envRegistered[0].icon !== void 0, envRegistered.length);
	check("legacy: trigger skipped without invoke", triggerSeats(envSeats).length === 0, envSeats.length);
}

// C: no modelDirectories service at all.
{
	const { mod, legacyCtx, envRegistered, envSeats } = makeLegacyEnv({ withModels: false });
	let threw = false;
	try { mod.apply(legacyCtx); } catch (error) { threw = true; console.error(error); }
	check("legacy: missing modelDirectories does not fail the load", threw === false);
	check("legacy: nothing registers without a directory service", envRegistered.length === 0 && triggerSeats(envSeats).length === 0, { commands: envRegistered.length, seats: envSeats.length });
}

// D: command.register refuses the contribution.
{
	const { mod, legacyCtx, envSeats } = makeLegacyEnv({ registerThrows: true });
	let threw = false;
	try { mod.apply(legacyCtx); } catch (error) { threw = true; console.error(error); }
	check("legacy: a refusing command.register does not fail the load", threw === false);
	check("legacy: no trigger after a refused command", triggerSeats(envSeats).length === 0, envSeats.length);
}

// E: React 17 (no useSyncExternalStore) — the trigger still renders through the fallback hook.
{
	const { mod, legacyCtx, envSeats } = makeLegacyEnv({ commandUi: { invoke: true }, reactOverrides: { useSyncExternalStore: undefined, useState: (init) => [init, () => {}], useEffect: (fn) => { fn(); } } });
	let threw = false;
	try { mod.apply(legacyCtx); } catch (error) { threw = true; console.error(error); }
	check("legacy: react-17 hooks do not fail the load", threw === false);
	const seats = triggerSeats(envSeats);
	check("legacy: trigger registers on react 17", seats.length === 1 && seats[0].key === "conversation.input.left", envSeats.map((s) => s.key));
	if (seats[0] !== void 0) {
		const seat = seats[0].seat;
		const face = seat.options.inject("session-1");
		const rendered = seat.component(face);
		check("legacy: react-17 trigger renders the pin button", rendered !== null && typeof rendered.props.onClick === "function", rendered);
	}
}

// F: no locale service — the built-in zh dictionary labels everything.
{
	const { mod, legacyCtx, envRegistered } = makeLegacyEnv({ withLocale: false });
	let threw = false;
	try { mod.apply(legacyCtx); } catch (error) { threw = true; console.error(error); }
	check("legacy: missing locale service does not fail the load", threw === false);
	check("legacy: labels fall back to the built-in dictionary", envRegistered.length === 2 && envRegistered[0].label() === "收藏置顶", envRegistered[0]?.label?.());
}

// ─── Phase 3: client-HMR re-activation stays idempotent ────────────────────
// Every save re-evaluates the bundle while the previous instance is still
// installed. That is what stacked one extra star per save in a live window, so
// a second registered module (same global symbol registry, fresh instance
// state) must reuse the first one's records instead of decorating again.
{
	const hotStore = createSnapshotStore({
		current: { provider: "p1", model: "m1" },
		routable: true,
		groups: [
			{ id: "p1", name: "Provider One", models: [{ id: "m1", name: "Alpha" }, { id: "m2", name: "Beta" }] },
			{ id: "p2", name: "Provider Two", models: [{ id: "m3", name: "Gamma" }] }
		],
		failures: [],
		status: "ready",
		pending: null,
		error: null
	});
	const hotDirectory = { store: hotStore, load: async () => hotStore.getSnapshot(), select: async () => ({ ok: true }), dispose() {} };
	const hotResolver = { live: { directories: { values: new Set([hotDirectory]) } }, directoryFor: () => hotDirectory };
	const hotCtx = {
		effect: (fn) => { fn(); },
		locale: ctx.locale,
		inject: (deps, callback) => {
			callback({
				modelDirectories: hotResolver,
				sessions: { subagentAddress: () => void 0 },
				get: (name) => (name === "commandUi" ? commandUi : void 0),
				slots,
				effect: (fn) => { fn(); }
			});
		}
	};
	mod.apply(hotCtx);
	const firstRecord = hotResolver[Symbol.for("dsh-client-ui-model-favorites/patched")];
	registration.current = null;
	await import(`${clientUrl}?hmr=1`);
	const hotMod = registration.current.factory(requireShim);
	check("re-activation is a distinct module evaluation", hotMod.apply !== mod.apply);
	hotMod.apply(hotCtx);
	const secondRecord = hotResolver[Symbol.for("dsh-client-ui-model-favorites/patched")];
	check("re-activation takes over the patch record", firstRecord !== void 0 && secondRecord !== void 0 && secondRecord !== firstRecord && typeof secondRecord.original === "function", { first: firstRecord !== void 0, took: secondRecord !== firstRecord });
	const hotNames = hotResolver.directoryFor("session-1").store.getSnapshot().groups.map((g) => g.models.map((m) => m.name));
	check("a bare re-activation changes nothing", JSON.stringify(hotNames) === JSON.stringify([["Alpha", "Beta"], ["Gamma"]]), hotNames);
	// Favorite through the NEWEST instance's own contribution: decoration must stay
	// one level deep. A stacked facade would nest the synthetic group (or repeat the
	// provider annotation) exactly the way the live window showed four stars.
	const newestFavorites = registered[registered.length - 2];
	await newestFavorites.ui.onSelect({ id: "p1/m2" });
	const hotGroups = hotResolver.directoryFor("session-1").store.getSnapshot().groups;
	const synthetic = hotGroups.filter((group) => group.id === "dsh-model-favorites");
	check("re-activation keeps one decoration layer", hotGroups.length === 3 && synthetic.length === 1 && synthetic[0].models.length === 1 && synthetic[0].models[0].name === "Beta（来自 Provider One）", hotGroups.map((group) => ({ id: group.id, models: group.models.map((model) => model.name) })));
	check("re-activation adds no second facade over the same real store", (() => {
		hotMod.apply(hotCtx);
		const again = hotResolver.directoryFor("session-1").store.getSnapshot().groups;
		return again.length === 3 && again.filter((group) => group.id === "dsh-model-favorites").length === 1 && hotStore.getSnapshot().groups.length === 2;
	})());
}

// ─── Phase 4: the row-level DOM bridge ─────────────────────────────────────
// The star mark, the synthetic group's visual lift and the right-click menu all
// talk to the shipped ModelSelect DOM, so a miniature DOM stands in for it.

const domDocument = (() => {
	const listeners = new Map();
	const byId = new Map();
	let root = null;
	const node = (tag, attrs = {}) => {
		const el = {
			tagName: tag.toUpperCase(),
			attributes: { ...attrs },
			children: [],
			style: {},
			parent: null,
			textContent: "",
			className: attrs.class ?? "",
			ownerDocument: null,
			append(...nodes) {
				for (const child of nodes) {
					child.parent = el;
					el.children.push(child);
				}
			},
			appendChild(child) {
				el.append(child);
				return child;
			},
			remove() {
				if (el.parent !== null) el.parent.children = el.parent.children.filter((child) => child !== el);
			},
			getAttribute: (name) => (name in el.attributes ? el.attributes[name] : null),
			setAttribute(name, value) {
				el.attributes[name] = String(value);
				if (name === "id") byId.set(String(value), el);
			},
			removeAttribute: (name) => { delete el.attributes[name]; },
			matches: (selector) => matchesSelector(el, selector),
			closest(selector) {
				let current = el;
				while (current !== null && current !== void 0) {
					if (matchesSelector(current, selector)) return current;
					current = current.parent;
				}
				return null;
			},
			querySelector: (selector) => el.querySelectorAll(selector)[0] ?? null,
			querySelectorAll: (selector) => queryAll(el, selector)
		};
		return el;
	};
	const descendants = (el) => el.children.flatMap((child) => [child, ...descendants(child)]);
	/** Only the selector shapes the bridge actually uses. */
	const matchCompound = (el, compound) => {
		const tokens = compound.match(/\[[^\]]+\]|\.[A-Za-z0-9_-]+|^[A-Za-z][A-Za-z0-9]*/gu) ?? [];
		for (const token of tokens) {
			if (token.startsWith("[")) {
				const body = token.slice(1, -1);
				const eq = body.match(/^([A-Za-z-]+)\$?=("?)(.*?)\2$/u);
				if (eq === null) {
					if (el.getAttribute(body) === null) return false;
					continue;
				}
				const value = el.getAttribute(eq[1]);
				if (value === null) return false;
				if (body.includes("$=") ? !value.endsWith(eq[3]) : value !== eq[3]) return false;
				continue;
			}
			if (token.startsWith(".")) {
				if (!String(el.className).split(/\s+/u).includes(token.slice(1))) return false;
				continue;
			}
			if (el.tagName !== token.toUpperCase()) return false;
		}
		return true;
	};
	const queryAll = (el, selector) => {
		const scoped = selector.startsWith(":scope > ");
		const compound = scoped ? selector.slice(9) : selector;
		const pool = scoped ? el.children : descendants(el);
		return pool.filter((candidate) => matchCompound(candidate, compound));
	};
	const matchesSelector = (el, selector) => matchCompound(el, selector.startsWith(":scope > ") ? selector.slice(9) : selector);
	const doc = {
		head: node("head"),
		body: node("body"),
		ownerDocument: null,
		createElement: (tag) => {
			const created = node(tag);
			created.ownerDocument = doc;
			return created;
		},
		getElementById: (id) => byId.get(id) ?? null,
		querySelectorAll: (selector) => queryAll(root, selector),
		addEventListener: (type, handler) => {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type).add(handler);
		},
		removeEventListener: (type, handler) => listeners.get(type)?.delete(handler)
	};
	root = node("html");
	root.append(doc.head, doc.body);
	doc.documentElement = root;
	doc.ownerDocument = doc;
	doc.head.ownerDocument = doc;
	doc.body.ownerDocument = doc;
	return {
		document: doc,
		node,
		/** Capture-phase dispatch: every ancestor handler runs, root last. */
		dispatch(target, type, event) {
			const handlers = listeners.get(type) ?? new Set();
			const chain = [];
			let current = target;
			while (current !== null && current !== void 0) {
				chain.push(current);
				current = current.parent;
			}
			for (const el of chain) {
				for (const handler of [...handlers]) handler({ type, target, preventDefault() {}, stopPropagation() {}, ...event });
			}
		}
	};
})();

// A right-clickable model menu: two provider sections, one favorite among them.
{
	const hotObservers = [];
	const store = createSnapshotStore({
		current: { provider: "p1", model: "m1" },
		routable: true,
		groups: [
			{ id: "p1", name: "Provider One", models: [{ id: "m1", name: "Alpha" }, { id: "m2", name: "Beta" }] },
			{ id: "p2", name: "Provider Two", models: [{ id: "m3", name: "Gamma" }] }
		],
		failures: [],
		status: "ready",
		pending: null,
		error: null
	});
	const domDirectory = { store, load: async () => store.getSnapshot(), select: async () => ({ ok: true }), dispose() {} };
	const domResolver = { live: { directories: { values: new Set([domDirectory]) } }, directoryFor: () => domDirectory };
	const domDictionaries = new Map();
	const domRegistered = [];
	const domSeats = [];
	const domCtx = {
		effect: (fn) => { fn(); },
		locale: {
			register: (ns, dicts) => { domDictionaries.set(ns, dicts); return () => {}; },
			bind: (ns) => (key) => domDictionaries.get(ns)?.zh?.[key] ?? key
		},
		inject: (deps, callback) => {
			callback({
				modelDirectories: domResolver,
				sessions: { subagentAddress: () => void 0 },
				get: (name) => (name === "commandUi" ? {
					register: (contribution) => { domRegistered.push(contribution); return () => {}; },
					invoke: () => {}
				} : void 0),
				slots: {
					inject: (key, cb) => { domSeats.push({ key, seat: cb() }); return () => {}; },
					register: (options, component) => ({ options, component })
				},
				effect: (fn) => { fn(); }
			});
		}
	};
	class FakeMutationObserver {
		constructor(callback) {
			this.callback = callback;
			hotObservers.push(this);
		}
		observe() {}
		disconnect() {}
	}
	const domWindow = globalThis.window;
	globalThis.window = {
		__ModuleLoader__: { load: (reg) => { registration.current = reg; } },
		document: domDocument.document,
		addEventListener: () => {},
		removeEventListener: () => {},
		MutationObserver: FakeMutationObserver,
		requestAnimationFrame: (fn) => { fn(); return 1; },
		setTimeout: (fn) => { fn(); return 1; }
	};
	globalThis.document = domDocument.document;
	globalThis.MutationObserver = FakeMutationObserver;
	const previousObservers = [...hotObservers];
	void previousObservers;
	registration.current = null;
	const preexistingObservers = hotObservers.length;
	await import(`${clientUrl}?dom=1`);
	const domShim = (spec) => {
		if (spec === "@deepseek-ai/dsh-client-store") return { createSnapshotStore };
		if (spec === "@deepseek-ai/dsh-client-ui-primitives") return {
			Button: () => null,
			IconPinFillRegular: () => null,
			MenuSurface: (props) => ({ type: "MenuSurface", props, children: props?.children })
		};
		if (spec === "react") return {
			createElement: (type, props, ...children) => ({ type, props, children: children.flat() }),
			useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
			useState: (init) => [init, () => {}],
			useEffect: (fn) => { fn(); }
		};
		if (spec === "react-dom") return { createPortal: (element) => ({ portal: element }) };
		throw new Error(`unexpected require("${spec}")`);
	};
	const domMod = registration.current.factory(domShim);
	domMod.apply(domCtx);
	// Favorite one model, then build the menu DOM the shipped ModelSelect renders.
	await domRegistered[0].ui.onSelect({ id: "p1/m2" });
	const doc = domDocument.document;
	const groupOf = (id, label, models) => {
		const section = doc.createElement("div");
		section.setAttribute("role", "group");
		const heading = doc.createElement("div");
		heading.setAttribute("id", `${id}-heading`);
		heading.textContent = label;
		section.append(heading);
		section.setAttribute("aria-labelledby", `${id}-heading`);
		for (const [key, name] of models) {
			const row = doc.createElement("button");
			row.setAttribute("role", "menuitemradio");
			row.setAttribute("title", name);
			const copy = doc.createElement("span");
			copy.textContent = name;
			row.append(copy);
			row.datasetKey = key;
			section.append(row);
		}
		return section;
	};
	const container = doc.createElement("div");
	container.setAttribute("id", "r0-models");
	container.setAttribute("role", "menu");
	container.append(
		groupOf("p1", "Provider One", [["p1/m1", "Alpha"], ["p1/m2", "Beta"]]),
		groupOf("p2", "Provider Two", [["p2/m3", "Gamma"]]),
		groupOf("fav", "收藏", [["p1/m2", "Beta（来自 Provider One）"]])
	);
	doc.body.append(container);
	const observer = hotObservers[preexistingObservers];
	observer.callback();
	const sections = container.children;
	// Section children are [heading, ...rows].
	const plainRow = sections[0].children[1];
	const favoriteRow = sections[0].children[2];
	check("the favorite row gains the divider and the yellow star", favoriteRow.querySelectorAll(".dsh-model-favorites-star").length === 1 && favoriteRow.querySelectorAll(".dsh-model-favorites-rule").length === 1, favoriteRow.children.length);
	check("the plain row stays unmarked", plainRow.querySelectorAll(".dsh-model-favorites-star").length === 0, plainRow.children.length);
	check("the star carries the gold color inline", favoriteRow.querySelector(".dsh-model-favorites-star") !== null);
	check("the synthetic section is lifted to the visual top", sections[2].style.order === "-1" && container.style.display === "flex" && container.style.flexDirection === "column", sections[2].style);
	// A right-click on the favorite row must open the menu for that model.
	domDocument.dispatch(favoriteRow.querySelector("span"), "contextmenu", { clientX: 120, clientY: 240 });
	const menuSeat = domSeats.find((entry) => entry.seat?.options?.id === "model-favorites-context-menu")?.seat;
	const menuTree = menuSeat?.component({});
	const labels = (menuTree?.portal?.children ?? []).flatMap((row) => row.children ?? []);
	check("right-click opens the context menu for that model", menuTree?.portal?.props?.style?.left === "120px" && labels.includes("取消收藏") && labels.includes("置顶"), labels);
	menuTree.portal.children[0].props.onClick();
	check("the menu action toggles the favorite", !domDirectory.store.getSnapshot().groups.some((group) => group.id === "dsh-model-favorites"), domDirectory.store.getSnapshot().groups.map((group) => group.id));
	globalThis.window = domWindow;
	delete globalThis.document;
	delete globalThis.MutationObserver;
}

const failed = assertions.filter((entry) => !entry.ok);
console.log(`\n${assertions.length - failed.length}/${assertions.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
