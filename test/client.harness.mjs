// Standalone harness for dsh-client-ui-model-favorites/lib/client.js.
// Loads the real bundle through a fake __ModuleLoader__ + fake store engine,
// then drives the plugin's data-layer decoration and /model-favorites command.

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

const directory = {
	store: realStore,
	load: async () => realStore.getSnapshot(),
	select: async () => ({ ok: true }),
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

const clientPath = process.argv[2];
await import(new URL(`file:///${clientPath.replace(/\\/gu, "/")}`).href);
check("bundle registered its module id", registration.current?.id === "dsh-client-ui-model-favorites", registration.current?.id);
const mod = registration.current.factory(requireShim);
check("exports apply", typeof mod.apply === "function");
check("exports inject list", JSON.stringify(mod.inject) === JSON.stringify(["modelDirectories", "commandUi", "sessions", "locale"]), mod.inject);

mod.apply(ctx);
check("command registered once", registered.length === 1, registered.length);
check("command name", registered[0]?.name === "model-favorites", registered[0]?.name);

// The composer toolbar trigger: an additive seat on conversation.input.left.
check("trigger seat contributed", slotSeats.length === 1 && slotSeats[0].key === "conversation.input.left", slotSeats.map((seat) => seat.key));
const seat = slotSeats[0]?.disposer;
check("trigger id and order", seat?.options.id === "model-favorites-trigger" && seat?.options.order === 50 && seat?.options.name === "conversation.input.left", seat?.options);
const face = seat.options.inject("session-1");
check("trigger inject face for a regular session", face.sessionId === "session-1" && face.available === true, face);
subagentAddressed = true;
const faceSub = seat.options.inject("session-9");
subagentAddressed = false;
check("trigger inject face hides for subagents", faceSub.available === false, faceSub);
const rendered = seat.component(face);
check("trigger renders the pin button", rendered !== null && typeof rendered.props.onClick === "function", rendered);
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
check("unpinned order preserved", JSON.stringify(before.groups.map((g) => g.models.map((m) => m.name))) === JSON.stringify([["Alpha", "Beta"], ["Gamma"]]), before.groups.map((g) => g.models.map((m) => m.name)));
check("unpin returns the raw snapshot identity", before === realStore.getSnapshot());

const options = await registered[0].ui.options({ sessionId: "session-1" });
check("options list every model and hide the clear row while empty", options.length === 3, options.map((row) => row.id));
check("options carry provider/model ids", options[0].id === "p1/m1" && options[1].id === "p1/m2" && options[2].id === "p2/m3", options.map((row) => row.id));
check("options mark the current model", options[0].detail === dictionaries.get("modelFavorites").zh["option.current"], options[0].detail);
check("options keep provider group labels", options[0].group.label === "Provider One", options[0].group);

// Pin the second model of provider one (Beta) and one from provider two (Gamma).
await registered[0].ui.onSelect({ id: "p1/m2" });
await registered[0].ui.onSelect({ id: "p2/m3" });

const after = served.store.getSnapshot();
const names = after.groups.map((g) => ({ id: g.id, models: g.models.map((m) => m.name) }));
check("pinned model floats to the top of its group with a marker", JSON.stringify(names[0]) === JSON.stringify({ id: "p1", models: ["Beta ★", "Alpha"] }), names);
check("groups holding favorites float ahead of the rest", names[1].id === "p2" && JSON.stringify(names[1].models) === JSON.stringify(["Gamma ★"]), names);
check("provider and model ids stay untouched", after.groups[0].id === "p1" && after.groups[0].models[0].id === "m2", after.groups[0]);
check("unrelated snapshot fields are preserved", after.current.provider === "p1" && after.status === "ready" && Array.isArray(after.failures));
check("the real store is never mutated", realStore.getSnapshot().groups[0].models[1].name === "Beta" && realStore.getSnapshot().groups[0].models[0].name === "Alpha");
check("subscribers were notified on pin changes", notifications >= 2, notifications);
check("real store updates still reach the facade", (() => {
	realStore.update((draft) => { draft.status = "loading"; });
	return served.store.getSnapshot().status === "loading";
})());

// Selection keeps resolving against the decorated snapshot, as the /model command does.
const pinnedRow = served.store.getSnapshot().groups[0].models[0];
check("pinned row keeps the selection identity", pinnedRow.id === "m2" && served.store.getSnapshot().groups[0].id === "p1");

// Unpin restores the original presentation and the raw identity.
await registered[0].ui.onSelect({ id: "p1/m2" });
const unpinned = served.store.getSnapshot().groups;
check("unpin clears that model's marker", unpinned.every((group) => group.models.every((model) => model.id !== "m2" || model.name === "Beta")), unpinned.map((g) => g.models.map((m) => m.name)));
check("only the still-pinned group floats first", unpinned[0].id === "p2" && unpinned[1].id === "p1", unpinned.map((g) => g.id));

// Clear-all row: available only while favorites exist, and it drops the list.
const rowsWithFavorites = await registered[0].ui.options({ sessionId: "session-1" });
const clearRow = rowsWithFavorites[rowsWithFavorites.length - 1];
check("clear row offered while favorites exist", rowsWithFavorites.length === 4 && clearRow.label === dictionaries.get("modelFavorites").zh["option.clear"], { count: rowsWithFavorites.length, last: clearRow });
await registered[0].ui.onSelect({ id: clearRow.id });
check("clear drops every pin", served.store.getSnapshot() === realStore.getSnapshot());
const rowsAfterClear = await registered[0].ui.options({ sessionId: "session-1" });
check("clear row hidden when empty", rowsAfterClear.length === 3, rowsAfterClear.length);

// dispose() tears the facade subscriptions down.
served.dispose();
const notificationsAtDispose = notifications;
await registered[0].ui.onSelect({ id: "p1/m1" });
check("no notifications after dispose", notifications === notificationsAtDispose, { notificationsAtDispose, notifications });

const failed = assertions.filter((entry) => !entry.ok);
console.log(`\n${assertions.length - failed.length}/${assertions.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
