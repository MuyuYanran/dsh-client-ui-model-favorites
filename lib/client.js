/**
 * Model favorites plugin — browser half.
 *
 * Adds two independent lists to the shipped model pickers without replacing any
 * shipped component:
 *
 * 1. 收藏 (favorites): one synthetic provider group named 收藏 is inserted first,
 *    holding the favorites in order, each row annotated with the provider it came
 *    from. `directory.select` is wrapped so a row of that group still resolves to
 *    its real provider/model.
 * 2. 置顶 (pinned): a model rises to the front of its own provider group; group
 *    and model ids stay untouched.
 *
 * Two layers deliver them:
 *
 * - Data layer (required): a decorator over every session `ModelDirectory.store`
 *   snapshot, which both consumers of that snapshot — the composer's
 *   `conversation.input.model` seat (ModelSelect) and the `/model` popup
 *   (optionsOf) — read, so nothing forks.
 * - DOM layer (degradable): a bridge over the rendered menu that maps rows back
 *   to `<provider>/<model>`, paints the gold star + divider on favorites, lifts
 *   the 收藏 section visually, and opens a pointer-anchored context menu (收藏 /
 *   置顶) from `shell.overlay` on right-click. Without a DOM, or after a menu
 *   redesign, the data layer alone still delivers both lists.
 *
 * Management also rides commands (`/model-favorites`, `/model-pins`), so neither
 * list depends on the context menu being reachable.
 *
 * Kernel compatibility: every optional surface (primitives, react-dom, React
 * hooks, the popup invocation path, the locale service, the slots) is
 * feature-detected and degrades independently; the lists fall back to a built-in
 * localStorage implementation when the kernel ships no snapshot store. The only
 * hard requirement is a `modelDirectories` service with a snapshot-shaped
 * directory store.
 */

window.__ModuleLoader__.load({
	id: "dsh-client-ui-model-favorites",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		/**
		 * Optional kernel surfaces, resolved defensively. Older kernels may lack
		 * any of these; every consumer degrades instead of throwing, because a
		 * throwing factory fails the whole plugin table load.
		 */
		const optional = (spec) => {
			try {
				return require(spec);
			} catch {
				return void 0;
			}
		};
		const storeModule = optional("@deepseek-ai/dsh-client-store");
		const createSnapshotStore = storeModule?.createSnapshotStore;
		const primitives = optional("@deepseek-ai/dsh-client-ui-primitives") ?? {};
		const IconPinFillRegular = primitives.IconPinFillRegular;
		const MenuSurface = primitives.MenuSurface;
		const reactDom = optional("react-dom") ?? {};
		const createPortal = reactDom.createPortal;
		const react = optional("react") ?? {};
		const createElement = react.createElement;
		const useSyncExternalStore = react.useSyncExternalStore;
		const reactState = react.useState;
		const reactEffect = react.useEffect;
		//#region lib/types/client/locales.js
		/** Dictionary namespace owned by this plugin. */
		const NS = "modelFavorites";
		/** The management command's name. */
		const COMMAND_NAME = "model-favorites";
		/** The per-provider 置顶 management command (right-click stays the fast path). */
		const PIN_COMMAND_NAME = "model-pins";
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"command.label": "收藏置顶",
			"command.description": "收藏模型并置顶显示；选择一行切换该模型的收藏状态",
			"option.clear": "清空全部收藏",
			"option.current": "当前使用",
			"provider.account": "DeepSeek 账号",
			"search.placeholder": "搜索模型…",
			"search.empty": "没有匹配的模型。",
			"empty.models": "没有可用的模型。",
			"error.unavailable": "子代理会话不支持收藏模型。",
			"group.favorites": "收藏",
			"group.from": "来自 {name}",
			"action.favorite": "收藏",
			"action.unfavorite": "取消收藏",
			"action.pin": "置顶",
			"action.unpin": "取消置顶",
			"option.pinned": "置顶",
			"option.clear.pins": "清空全部置顶",
			"pin.command.label": "置顶模型",
			"pin.command.description": "把模型置顶到它所属的供应商分组最前面；选择一行切换置顶状态"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			"command.label": "Pin favorites",
			"command.description": "Pin models to the top; select a row to toggle that model's pin",
			"option.clear": "Clear all favorites",
			"option.current": "In use",
			"provider.account": "DeepSeek Account",
			"search.placeholder": "Search models…",
			"search.empty": "No matching models.",
			"empty.models": "No models available.",
			"error.unavailable": "Model favorites are unavailable for addressed subagent sessions.",
			"group.favorites": "Favorites",
			"group.from": "from {name}",
			"action.favorite": "Add to favorites",
			"action.unfavorite": "Remove from favorites",
			"action.pin": "Pin to top",
			"action.unpin": "Unpin",
			"option.pinned": "pinned",
			"option.clear.pins": "Clear all pins",
			"pin.command.label": "Pin models",
			"pin.command.description": "Lift a model to the top of its provider group; select a row to toggle its pin"
		};
		/**
		 * Module-level dictionary handle. `apply` swaps in the kernel-bound
		 * translator once the locale service is there; until then the built-in zh
		 * dictionary answers, so the data layer never depends on locale timing.
		 */
		let translate = (key) => zh[key] ?? key;
		//#endregion
		//#region lib/types/client/favorites.js
		/** localStorage key backing the ordered favorites list. */
		const STORAGE_KEY = "dsh-client-ui-model-favorites";
		/** Row id of the management command's clear-all action (never a provider/model key). */
		const CLEAR_ID = "\u0000model-favorites:clear";
		/** Row id of the pin command's clear-all action. */
		const CLEAR_PIN_ID = "\u0000model-favorites:clear-pins";
		/**
		 * Synthetic provider group id holding the favorites. It can never collide
		 * with a real provider id (those are lowercase token names) and it is a
		 * valid HTML id fragment, because the shipped pickers derive row ids from it.
		 * It also sorts after the two provider ids the shipped menu promotes, so the
		 * plugin lifts the group visually — see the DOM bridge.
		 */
		const FAVORITES_GROUP_ID = "dsh-model-favorites";
		/** True for a `<provider>/<model>` row key. */
		function isKey(value) {
			return typeof value === "string" && value.includes("/");
		}
		/**
		 * Coerce persisted or adopted data into the two-list shape. `ordered` holds
		 * the favorites (shown in the synthetic 收藏 group), `pinned` the models a
		 * right-click pinned inside their own provider group. Lists saved by an
		 * earlier version only had `ordered`, so they migrate as-is with no pins.
		 * @param value - the parsed storage payload.
		 * @returns a fresh `{ ordered, pinned }` state.
		 */
		function normalizeState(value) {
			const source = value !== null && typeof value === "object" ? value : {};
			return {
				ordered: Array.isArray(source.ordered) ? source.ordered.filter(isKey) : [],
				pinned: Array.isArray(source.pinned) ? source.pinned.filter(isKey) : []
			};
		}
		/**
		 * Build the favorites store. The kernel's snapshot store (with its built-in
		 * localStorage persistence) is preferred; when it is missing or refuses the
		 * persistence option, a minimal stand-in keeps the plugin alive — losing
		 * nothing but the rides on immer.
		 * @returns a store honouring the getSnapshot/subscribe/update/set contract.
		 */
		function createFavoritesStore() {
			if (typeof createSnapshotStore === "function") {
				try {
					const store = createSnapshotStore(normalizeState(void 0), { persist: { name: STORAGE_KEY } });
					if (store !== null && typeof store === "object" && typeof store.getSnapshot === "function" && typeof store.subscribe === "function" && typeof store.update === "function" && typeof store.set === "function") return store;
					console.warn("[model-favorites] snapshot store contract incomplete; using the built-in fallback");
				} catch (error) {
					console.warn("[model-favorites] snapshot store unavailable; using the built-in fallback:", error);
				}
			}
			let state = normalizeState(void 0);
			if (typeof localStorage !== "undefined") {
				try {
					const raw = localStorage.getItem(STORAGE_KEY);
					if (typeof raw === "string") state = normalizeState(JSON.parse(raw));
				} catch {}
			}
			const listeners = new Set();
			const persist = () => {
				if (typeof localStorage === "undefined") return;
				try {
					localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
				} catch {}
			};
			const notify = () => {
				for (const listener of [...listeners]) listener();
			};
			return {
				getSnapshot: () => state,
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				update(mutator) {
					const draft = JSON.parse(JSON.stringify(state));
					mutator(draft);
					state = draft;
					persist();
					notify();
				},
				set(next) {
					state = next;
					persist();
					notify();
				}
			};
		}
		/**
		 * Cross-instance shared slot. Client HMR re-evaluates this module on every
		 * save while older instances stay alive, so the two lists must be one store
		 * object that every instance subscribes to and reads — otherwise a facade
		 * created by an older activation keeps the old instance's store, and a toggle
		 * made through the newest command changes nothing that the live menu sees.
		 */
		const SHARED = Symbol.for("dsh-client-ui-model-favorites/shared");
		/**
		 * The shared slot, created on first use.
		 * @returns `{ store?, favoriteKeys?, pinnedKeys?, translate? }`.
		 */
		function sharedSlot() {
			let slot = globalThis[SHARED];
			if (slot === void 0) {
				slot = {};
				globalThis[SHARED] = slot;
			}
			return slot;
		}
		/**
		 * The live list/dictionary accessors: whichever instance activated last owns
		 * them, and earlier instances fall back to their own module state.
		 * @returns `{ favoriteKeys, pinnedKeys, translate }`.
		 */
		function sharedSource() {
			const slot = sharedSlot();
			return {
				favoriteKeys: typeof slot.favoriteKeys === "function" ? slot.favoriteKeys : favoriteKeys,
				pinnedKeys: typeof slot.pinnedKeys === "function" ? slot.pinnedKeys : pinnedKeys,
				translate: typeof slot.translate === "function" ? slot.translate : (key) => translate(key)
			};
		}
		/**
		 * The two lists' store: created once per process and shared by every module
		 * evaluation, so all instances read, write and subscribe to the same object.
		 */
		const favorites = sharedSlot().store ?? (sharedSlot().store = createFavoritesStore());
		/**
		 * Monotonic favorites revision. Derived snapshots cache by
		 * (raw snapshot identity, revision), so a pin toggle invalidates every
		 * live directory without touching the real directories.
		 */
		let favoritesVersion = 0;
		// Registered before any directory wrapper exists: notification order then
		// guarantees the revision is bumped before wrappers recompute.
		favorites.subscribe(() => {
			favoritesVersion += 1;
		});
		/** Live favorites list (the 收藏 group's order). */
		function favoriteKeys() {
			const ordered = favorites.getSnapshot().ordered;
			return Array.isArray(ordered) ? ordered : [];
		}
		/** Live pinned list (models lifted to the top of their provider group). */
		function pinnedKeys() {
			const pinned = favorites.getSnapshot().pinned;
			return Array.isArray(pinned) ? pinned : [];
		}
		/**
		 * Adopt another window's lists (same-origin tabs share the localStorage key
		 * but not the in-memory store).
		 */
		if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
			window.addEventListener("storage", (event) => {
				if (event.key !== STORAGE_KEY || typeof event.newValue !== "string") return;
				try {
					favorites.set(normalizeState(JSON.parse(event.newValue)));
				} catch (error) {
					console.error("[model-favorites] failed to adopt another window's favorites:", error);
				}
			});
		}
		/**
		 * Toggle one `<provider>/<model>` key inside one of the two lists.
		 * @param field - `ordered` for 收藏, `pinned` for 置顶.
		 * @param key - the row id, which is exactly the provider/model identity.
		 */
		function toggleKey(field, key) {
			const index = (field === "pinned" ? pinnedKeys() : favoriteKeys()).indexOf(key);
			favorites.update((draft) => {
				if (!Array.isArray(draft[field])) draft[field] = [];
				if (index === -1) draft[field].push(key);
				else draft[field].splice(index, 1);
			});
		}
		/** Toggle one model's favorite state (the 收藏 group). */
		function toggleFavorite(key) {
			toggleKey("ordered", key);
		}
		/** Toggle one model's per-provider pinned state (置顶). */
		function togglePin(key) {
			toggleKey("pinned", key);
		}
		/** Drop every favorite; pins are untouched. */
		function clearFavorites() {
			if (favoriteKeys().length === 0) return;
			favorites.set({
				ordered: [],
				pinned: pinnedKeys()
			});
		}
		/** Drop every pin; favorites are untouched. */
		function clearPins() {
			if (pinnedKeys().length === 0) return;
			favorites.set({
				ordered: favoriteKeys(),
				pinned: []
			});
		}
		/**
		 * Derive the favorites-aware snapshot from one real directory snapshot.
		 *
		 * Two independent layers ride the same snapshot:
		 *
		 * - 置顶 (pinned): the model moves to the front of its own provider group.
		 *   Group ids and model ids stay untouched, so row ids and selection keep
		 *   resolving exactly as the shipped pickers expect.
		 * - 收藏 (favorites): one synthetic provider group named 收藏 is inserted
		 *   first, holding every favorite in favorite order. Its rows keep the real
		 *   model object but carry a composite `<provider>/<model>` model id and a
		 *   `名称（来自 供应商）` label, because the group id can no longer name the
		 *   provider. {@link decorateDirectory} maps that composite id back before
		 *   the real `select` runs, so picking a favorite row still selects the
		 *   right model.
		 *
		 * Unrelated fields are shared with the input snapshot, and a snapshot with
		 * neither list (and no stale marker to clean) returns the input identity so
		 * `useSyncExternalStore` consumers never re-render for nothing.
		 *
		 * Every name is normalized first: an earlier plugin version appended `☆`/`★`
		 * to names, and a live window keeps those old store facades stacked until it
		 * reloads. Stripping the suffixes here — without ever appending one — means a
		 * stacked window shows clean names instead of one marker per layer.
		 *
		 * @param snapshot - the real directory snapshot.
		 * @returns the decorated snapshot, or the input when nothing changed.
		 */
		function decorateSnapshot(snapshot) {
			if (snapshot === null || typeof snapshot !== "object" || !Array.isArray(snapshot.groups)) return snapshot;
			const source = sharedSource();
			const t = source.translate;
			const pinned = source.pinnedKeys();
			const ordered = source.favoriteKeys();
			const rank = new Map();
			for (let index = 0; index < pinned.length; index += 1) rank.set(pinned[index], index);
			const catalog = new Map();
			let changed = false;
			const groups = [];
			for (const group of snapshot.groups) {
				const lifted = [];
				const rest = [];
				let groupChanged = false;
				for (const model of group.models) {
					const name = stripMarkers(model.name);
					const entry = name === model.name ? model : {
						...model,
						name
					};
					if (entry !== model) groupChanged = true;
					const key = `${group.id}/${model.id}`;
					catalog.set(key, {
						group,
						model: entry
					});
					const at = rank.get(key);
					if (at === void 0) rest.push(entry);
					else lifted.push({
						model: entry,
						at
					});
				}
				if (lifted.length === 0) {
					if (groupChanged) changed = true;
					groups.push(groupChanged ? {
						...group,
						models: rest
					} : group);
					continue;
				}
				changed = true;
				lifted.sort((left, right) => left.at - right.at);
				groups.push({
					...group,
					models: [...lifted.map(({ model }) => model), ...rest]
				});
			}
			const favorites = [];
			for (const key of ordered) {
				const hit = catalog.get(key);
				if (hit === void 0) continue;
				const label = providerLabelOf(hit.group, t);
				favorites.push({
					...hit.model,
					id: key,
					name: `${hit.model.name}（${format(t("group.from"), { name: label })}）`
				});
			}
			if (favorites.length > 0) {
				changed = true;
				groups.unshift({
					id: FAVORITES_GROUP_ID,
					name: t("group.favorites"),
					models: favorites
				});
			}
			return changed ? {
				...snapshot,
				groups
			} : snapshot;
		}
		/** The provider heading the shipped pickers render for one group. */
		function providerLabelOf(group, t) {
			return group.id === "deepseek-account" ? t("provider.account") : group.name;
		}
		/** Trailing `☆`/`★` markers an earlier plugin version appended to names. */
		const LEGACY_MARKER = /[\s\u2605\u2606]+$/u;
		/**
		 * Normalize a model name: strip any trailing star a previous version
		 * appended. Never appends one — the current version paints the star in the
		 * DOM instead, so a fresh name has to stay byte-identical.
		 * @param name - the catalog name.
		 * @returns the name without trailing markers.
		 */
		function stripMarkers(name) {
			if (typeof name !== "string" || name === "") return name;
			return LEGACY_MARKER.test(name) ? name.replace(LEGACY_MARKER, "") : name;
		}
		/**
		 * Fill `{name}`-style placeholders in one dictionary string, so the plugin
		 * works with both the bound kernel dictionary and its built-in fallback.
		 * @param template - the dictionary string.
		 * @param params - placeholder values.
		 * @returns the formatted string.
		 */
		function format(template, params) {
			return String(template).replace(/\{(\w+)\}/gu, (match, key) => (params[key] === void 0 ? match : String(params[key])));
		}
		//#endregion
		//#region lib/types/client/directory.js
		/**
		 * Marks a directory whose store serves favorites-aware snapshots. The key is
		 * a registered symbol, so a second evaluation of this module (client HMR
		 * re-activates the plugin on every save) finds the record the previous
		 * instance left behind instead of stacking another facade on top of it —
		 * that is what used to duplicate the star marker once per save.
		 */
		const WRAPPED = Symbol.for("dsh-client-ui-model-favorites/wrapped");
		/** The resolver's patch record, shared across module evaluations the same way. */
		const PATCHED = Symbol.for("dsh-client-ui-model-favorites/patched");
		/** Marks a directory whose `dispose` already releases the facade. */
		const DISPOSED = Symbol.for("dsh-client-ui-model-favorites/dispose-wrapped");
		/**
		 * Identity of this module evaluation. Only the newest instance keeps the
		 * facade installed; an older instance whose token no longer matches is
		 * simply replaced, so repeated activation converges on one decoration.
		 */
		const TOKEN = Object.freeze({});
		/**
		 * Map one selection coming out of the decorated snapshot back to the real
		 * provider/model pair. Rows in the synthetic 收藏 group report the synthetic
		 * group id as their provider and the composite `<provider>/<model>` key as
		 * their model id, because a row's identity is `group.id` plus `model.id`.
		 * Everything else passes through untouched.
		 *
		 * @param selection - the selection the shipped picker built from a row.
		 * @returns the selection the directory can actually apply.
		 */
		function realSelection(selection) {
			if (selection === null || typeof selection !== "object") return selection;
			if (selection.provider !== FAVORITES_GROUP_ID) return selection;
			const key = String(selection.model);
			const at = key.indexOf("/");
			if (at <= 0 || at === key.length - 1) return selection;
			return {
				...selection,
				provider: key.slice(0, at),
				model: key.slice(at + 1)
			};
		}
		/**
		 * Replace one directory's store with a favorites-aware facade over the real
		 * store. The facade keeps the whole store contract (`getSnapshot`,
		 * `subscribe`, `update`, `set`), forwards writes to the real store, and
		 * notifies its own subscribers whenever either the real snapshot or the
		 * favorites list changes. `dispose` is wrapped so both subscriptions die
		 * with the session scope.
		 *
		 * Re-decorating an already decorated directory rebases on the store it
		 * originally served, so a re-activation never nests facades.
		 *
		 * @param directory - the live ModelDirectory instance.
		 * @returns the same instance, decorated in place.
		 */
		function decorateDirectory(directory) {
			if (directory === null || typeof directory !== "object") return directory;
			const previous = directory[WRAPPED];
			if (previous !== void 0 && previous.token === TOKEN) return directory;
			const served = directory.store;
			const real = previous === void 0 ? served : previous.raw;
			if (real === null || typeof real !== "object" || typeof real.getSnapshot !== "function" || typeof real.subscribe !== "function") return directory;
			if (previous !== void 0) {
				// Re-activation must keep the *same* store object. A mounted picker
				// holds whatever `directory.store` handed it when its slot inject ran;
				// replacing that object (or dropping its listeners, as this used to)
				// left the live menu reading a dead cache, so a favorite or pin only
				// showed up after a manual reload.
				previous.rebind(real);
				previous.token = TOKEN;
				snapshotProbe = previous.getSnapshot;
				return directory;
			}
			let current = real;
			let unsubscribeReal = () => {};
			let unsubscribeFavorites = () => {};
			let cachedRaw = null;
			let cachedVersion = -1;
			let cached = null;
			const listeners = new Set();
			const getSnapshot = () => {
				const raw = current.getSnapshot();
				if (raw !== cachedRaw || favoritesVersion !== cachedVersion) {
					cachedRaw = raw;
					cachedVersion = favoritesVersion;
					cached = decorateSnapshot(raw);
				}
				return cached;
			};
			const notify = () => {
				// Any list change invalidates the decorated cache; the next reader
				// recomputes through the shared source, so a facade created by an
				// older instance still serves the newest instance's lists.
				cachedRaw = null;
				cachedVersion = -1;
				cached = null;
				for (const listener of [...listeners]) listener();
			};
			const bind = (next) => {
				unsubscribeReal();
				unsubscribeFavorites();
				current = next;
				cachedRaw = null;
				cachedVersion = -1;
				cached = null;
				unsubscribeReal = current.subscribe(notify);
				// The favorites subscription always belongs to the newest module
				// instance, so its (possibly new) store drives the live facade.
				unsubscribeFavorites = favorites.subscribe(notify);
			};
			bind(real);
			snapshotProbe = getSnapshot;
			directory[WRAPPED] = {
				token: TOKEN,
				raw: real,
				getSnapshot,
				rebind(next) {
					this.raw = next;
					bind(next);
					notify();
				},
				dispose() {
					unsubscribeReal();
					unsubscribeFavorites();
					listeners.clear();
				}
			};
			directory.store = {
				getSnapshot,
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				update(mutator) {
					return current.update(mutator);
				},
				set(next) {
					return current.set(next);
				}
			};
			// Selection remap: the composer seat calls `directory.select` through its
			// slot inject face and the /model popup calls it directly, so wrapping the
			// method on the instance covers both without touching their registrations.
			// It runs on the first decoration only; the remap itself is stateless, so
			// a later activation keeps this wrapper and its plain method beneath it.
			const baseSelect = directory.select;
			if (typeof baseSelect === "function") directory.select = function (selection) {
				return baseSelect.call(this, realSelection(selection));
			};
			if (directory[DISPOSED] !== true) {
				const originalDispose = directory.dispose;
				if (typeof originalDispose === "function") {
					directory[DISPOSED] = true;
					directory.dispose = function () {
						const record = directory[WRAPPED];
						if (record !== void 0) {
							delete directory[WRAPPED];
							record.dispose();
						}
						return originalDispose.call(this);
					};
				}
			}
			return directory;
		}
		/**
		 * Decorate every directory the resolver already minted, then route future
		 * `directoryFor` calls through {@link decorateDirectory}.
		 *
		 * `directoryFor` is looked up on the service instance by both shipped
		 * consumers (the composer seat's slot inject and the /model command), so an
		 * own-property wrapper covers both without touching their registrations.
		 * The wrapper is always rebuilt from the method it originally replaced, so
		 * re-activation keeps the chain one level deep.
		 *
		 * @param resolver - the `modelDirectories` service instance.
		 */
		function patchResolver(resolver) {
			if (resolver === null || (typeof resolver !== "object" && typeof resolver !== "function")) return;
			const record = resolver[PATCHED];
			if (record !== void 0 && record.token === TOKEN) return;
			const current = resolver.directoryFor;
			const original = record === void 0 ? current : record.original;
			if (typeof original !== "function") return;
			const patched = function (sessionId) {
				return decorateDirectory(original.call(this, sessionId));
			};
			try {
				resolver.directoryFor = patched;
				// The service is reached through cordis' traceable proxy, whose get
				// trap wraps functions — so verify the own descriptor instead of
				// comparing the read-back value.
				const descriptor = Object.getOwnPropertyDescriptor(resolver, "directoryFor");
				if (descriptor === void 0 || descriptor.value !== patched) throw new Error("the service refused the directoryFor override");
				resolver[PATCHED] = {
					token: TOKEN,
					original,
					patched
				};
				const values = resolver.live?.directories?.values;
				if (values !== void 0 && typeof values[Symbol.iterator] === "function") for (const directory of values) decorateDirectory(directory);
				ensureDomBridge();
				console.info(record === void 0 ? "[model-favorites] modelDirectories.directoryFor wrapped" : "[model-favorites] modelDirectories.directoryFor re-wrapped by a newer activation");
			} catch (error) {
				console.error("[model-favorites] failed to wrap modelDirectories.directoryFor:", error);
			}
		}
		//#endregion
		//#region lib/types/client/dom.js
		/**
		 * The shipped composer model menu, as the DOM exposes it: ModelSelect portals
		 * a `MenuSurface` with `role="menu"` and id `<useId>-models`, groups render
		 * as `role="group"` sections, and every model row is a `role="menuitemradio"`
		 * button carrying the model name as its title.
		 */
		const MENU_SELECTOR = "[id$=\"-models\"][role=\"menu\"]";
		/** One selectable model row inside that menu. */
		const ROW_SELECTOR = "[role=\"menuitemradio\"]";
		/** One provider section inside that menu. */
		const SECTION_SELECTOR = "[role=\"group\"]";
		/** True while the star slot is present on a row. */
		const MARKED = "mfMarked";
		/** Star slot class, styled by the injected stylesheet. */
		const STAR_CLASS = "dsh-model-favorites-star";
		/** Divider slot class (the markdown-table style rule before the star). */
		const RULE_CLASS = "dsh-model-favorites-rule";
		/** The context menu's own class, used to tell its clicks from outside ones. */
		const MENU_CLASS = "dsh-model-favorites-menu";
		/** Inline style id guarding against duplicate stylesheet injection. */
		const STYLE_ID = "dsh-model-favorites-style";
		/** `<provider>/<model>` for every row the bridge has mapped. */
		const rowKeys = new WeakMap();
		/** Most recent decorated snapshot; the bridge maps DOM rows against it. */
		let latestSnapshot = null;
		/** Reads the newest decorated facade's snapshot (set by decorateDirectory). */
		let snapshotProbe = null;
		/** Bridge teardown, replaced on every install. */
		let bridgeTeardown = null;
		/** The context menu's current request (`null` while closed). */
		let contextRequest = null;
		const contextListeners = new Set();
		/** Notify context-menu subscribers. */
		function notifyContext() {
			for (const listener of [...contextListeners]) listener();
		}
		/**
		 * Subscribe to the context-menu request, in the shape
		 * `useSyncExternalStore` wants.
		 * @param listener - the React subscriber.
		 * @returns the unsubscribe function.
		 */
		function subscribeContext(listener) {
			contextListeners.add(listener);
			return () => {
				contextListeners.delete(listener);
			};
		}
		/** The current context-menu request, or null. */
		function currentContext() {
			return contextRequest;
		}
		/**
		 * Open the row context menu at a viewport point.
		 * @param request - `{ x, y, key, name, provider, favorited, pinned }`.
		 */
		function openContext(request) {
			contextRequest = request;
			notifyContext();
		}
		/** Close the context menu (a no-op while it is already closed). */
		function closeContext() {
			if (contextRequest === null) return;
			contextRequest = null;
			notifyContext();
		}
		/** Inject the star/divider stylesheet once. */
		function ensureStyles(doc) {
			if (doc.getElementById(STYLE_ID) !== null) return;
			const style = doc.createElement("style");
			style.id = STYLE_ID;
			style.textContent = [
				// Inline marks only: the shipped `optionCopy` is a *column* flex box, so
				// anything appended there lands on a line of its own. These go inside
				// the `modelName` span instead, which is nowrap, giving `名称 │ ★`.
				`.${STAR_CLASS}{display:inline-block;vertical-align:middle;color:#f5b301;font-size:11px;line-height:1;margin-left:5px}`,
				`.${RULE_CLASS}{display:inline-block;vertical-align:middle;height:11px;margin-left:7px;border-left:1px solid currentColor;opacity:.28}`,
				".dsh-model-favorites-menu{min-width:168px;padding:4px}",
				".dsh-model-favorites-menu button{display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;border:0;border-radius:6px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}",
				".dsh-model-favorites-menu button:hover{background:color-mix(in srgb, currentColor 12%, transparent)}",
				".dsh-model-favorites-menu-icon{display:inline-flex;align-items:center}"
			].join("\n");
			(doc.head ?? doc.documentElement)?.appendChild(style);
		}
		/**
		 * Read the heading a provider section renders, so a DOM section can be
		 * matched to the snapshot group it came from. The shipped `MenuGroup` labels
		 * its `role="group"` section through `aria-labelledby`, with `aria-label` as
		 * the fallback; the first child's text is the last resort.
		 * @param section - the `role="group"` element.
		 * @returns the heading text, trimmed.
		 */
		function sectionLabel(section) {
			const doc = section.ownerDocument;
			const labelledBy = section.getAttribute("aria-labelledby");
			if (labelledBy !== null && labelledBy !== "") {
				const heading = doc?.getElementById?.(labelledBy);
				if (heading !== null && heading !== void 0) return (heading.textContent ?? "").trim();
			}
			const ariaLabel = section.getAttribute("aria-label");
			if (ariaLabel !== null && ariaLabel !== "") return ariaLabel.trim();
			return (section.querySelector(":scope > *")?.textContent ?? "").trim();
		}
		/**
		 * Resolve one DOM row to its `<provider>/<model>` key by matching the visible
		 * section heading and row title against the live decorated snapshot. Name
		 * matching (rather than DOM position) keeps the mapping correct while the
		 * shipped search filters the list down to a subset of rows.
		 *
		 * @param snapshot - the decorated directory snapshot.
		 * @param section - the row's `role="group"` section.
		 * @param row - the `role="menuitemradio"` button.
		 * @param claimed - keys already matched in this pass (duplicate names).
		 * @returns the row key, or undefined when the row is not catalog-backed.
		 */
		function resolveRowKey(snapshot, section, row, claimed) {
			const label = sectionLabel(section);
			const title = (row.getAttribute("title") ?? row.textContent ?? "").trim();
			for (const group of snapshot.groups) {
				const heading = providerLabelOf(group, translate);
				const groupName = group.id === FAVORITES_GROUP_ID ? translate("group.favorites") : heading;
				if (label !== heading && label !== groupName) continue;
				for (const model of group.models) {
					if (title !== model.name && !title.startsWith(`${model.name}（`) && !title.startsWith(`${model.name} (`)) continue;
					const key = group.id === FAVORITES_GROUP_ID ? String(model.id) : `${group.id}/${model.id}`;
					if (claimed.has(key)) continue;
					claimed.add(key);
					return key;
				}
			}
			return void 0;
		}
		/**
		 * Add or remove the divider + yellow star on one row, and keep the row
		 * mapped for the context menu. The marks go inside the row's name span, so
		 * they share its line (`名称 │ ★`) instead of stacking under the name the way
		 * the column-flex copy container would lay them out.
		 * @param row - the model row button.
		 * @param favorited - whether the row's model is currently favorited.
		 */
		function markRow(row, favorited) {
			const rule = row.querySelector(`.${RULE_CLASS}`);
			const star = row.querySelector(`.${STAR_CLASS}`);
			if (!favorited) {
				row.removeAttribute(MARKED);
				rule?.remove();
				star?.remove();
				return;
			}
			if (star !== null) return;
			const copy = row.querySelector(":scope > span") ?? row;
			const host = copy.querySelector(":scope > span") ?? copy;
			const doc = row.ownerDocument;
			const ruleNode = doc.createElement("span");
			ruleNode.className = RULE_CLASS;
			ruleNode.setAttribute("aria-hidden", "true");
			const starNode = doc.createElement("span");
			starNode.className = STAR_CLASS;
			starNode.setAttribute("aria-hidden", "true");
			starNode.textContent = "★";
			host.append(ruleNode, starNode);
			row.setAttribute(MARKED, "");
		}
		/**
		 * Annotate every rendered model menu: map rows to catalog keys, paint the
		 * favorite mark, and lift the synthetic 收藏 section to the visual top.
		 *
		 * The lift uses CSS `order` on a column-flex container rather than moving
		 * DOM nodes, so React's reconciliation and the menu's own row indexing stay
		 * exactly as shipped.
		 *
		 * @param doc - the document to scan.
		 */
		function annotateMenus(doc) {
			const snapshot = latestSnapshot;
			if (snapshot === null) return;
			const favorites = new Set(favoriteKeys());
			for (const container of doc.querySelectorAll(MENU_SELECTOR)) {
				const sections = [...container.children].filter((child) => child.matches?.(SECTION_SELECTOR));
				if (sections.length === 0) continue;
				const claimed = new Set();
				let lifted = null;
				for (const section of sections) {
					const label = sectionLabel(section);
					if (label === translate("group.favorites") && lifted === null) lifted = section;
					for (const row of section.querySelectorAll(ROW_SELECTOR)) {
						const key = resolveRowKey(snapshot, section, row, claimed);
						if (key === void 0) continue;
						rowKeys.set(row, key);
						markRow(row, favorites.has(key));
					}
				}
				if (lifted !== null) {
					const style = container.style;
					if (style.display !== "flex") style.display = "flex";
					if (style.flexDirection !== "column") style.flexDirection = "column";
					if (lifted.style.order !== "-1") lifted.style.order = "-1";
				}
			}
		}
		/**
		 * Install the row-level bridge over the shipped model menu. Every entry point
		 * is optional: without a DOM, without the menu, or without a decorated
		 * snapshot the bridge stays inert and the data layer alone still works.
		 *
		 * @param host - the window-like host (`window`).
		 * @param resolveSnapshot - pulls the live decorated snapshot.
		 * @returns a teardown function.
		 */
		function installDomBridge(host, resolveSnapshot) {
			const doc = host?.document;
			if (doc === void 0 || typeof doc.querySelectorAll !== "function" || typeof host.MutationObserver !== "function" && typeof host.requestAnimationFrame !== "function") {
				console.warn("[model-favorites] DOM bridge unavailable — the menu keeps the data-level decoration only");
				return () => {};
			}
			ensureStyles(doc);
			let queued = false;
			const run = () => {
				queued = false;
				try {
					latestSnapshot = resolveSnapshot() ?? latestSnapshot;
					annotateMenus(doc);
				} catch (error) {
					console.warn("[model-favorites] failed to annotate the model menu:", error);
				}
			};
			const schedule = () => {
				if (queued) return;
				queued = true;
				if (typeof host.requestAnimationFrame === "function") host.requestAnimationFrame(run);
				else host.setTimeout(run, 16);
			};
			const onContextMenu = (event) => {
				const target = event.target;
				if (target === null || typeof target.closest !== "function") return;
				const row = target.closest(ROW_SELECTOR);
				const key = row === null ? void 0 : rowKeys.get(row);
				if (key === void 0) {
					closeContext();
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				const at = key.indexOf("/");
				const favorited = favoriteKeys().includes(key);
				const pinned = pinnedKeys().includes(key);
				openContext({
					x: event.clientX ?? 0,
					y: event.clientY ?? 0,
					key,
					name: (row.getAttribute("title") ?? row.textContent ?? key).trim(),
					provider: at > 0 ? key.slice(0, at) : key,
					favorited,
					pinned
				});
			};
			const onPointerDown = (event) => {
				const target = event.target;
				if (contextRequest === null || target === null || typeof target.closest !== "function") return;
				// A pointer-down inside the menu itself must survive: closing here would
				// unmount the row before its click ever lands.
				if (target.closest(`.${MENU_CLASS}`) !== null) return;
				if (target.closest(`.${STAR_CLASS}`) !== null || target.closest(`.${RULE_CLASS}`) !== null) return;
				closeContext();
			};
			const onKeyDown = (event) => {
				if (event.key === "Escape") closeContext();
			};
			doc.addEventListener("contextmenu", onContextMenu, true);
			doc.addEventListener("pointerdown", onPointerDown, true);
			doc.addEventListener("keydown", onKeyDown, true);
			host.addEventListener("blur", closeContext);
			host.addEventListener("resize", closeContext);
			doc.addEventListener("scroll", closeContext, true);
			let observer = null;
			if (typeof host.MutationObserver === "function") {
				observer = new host.MutationObserver(schedule);
				observer.observe(doc.body ?? doc.documentElement, {
					childList: true,
					subtree: true
				});
			}
			schedule();
			return () => {
				observer?.disconnect();
				doc.removeEventListener("contextmenu", onContextMenu, true);
				doc.removeEventListener("pointerdown", onPointerDown, true);
				doc.removeEventListener("keydown", onKeyDown, true);
				doc.removeEventListener("scroll", closeContext, true);
				host.removeEventListener("blur", closeContext);
				host.removeEventListener("resize", closeContext);
				closeContext();
			};
		}
		/**
		 * Install the bridge once per module evaluation, remembering the teardown so
		 * a re-activation replaces the previous one instead of stacking listeners.
		 */
		function ensureDomBridge() {
			if (typeof window === "undefined" || typeof document === "undefined") return;
			// `window` is the browser global; the plain global object stands in on
			// kernels that expose the DOM without it.
			const host = typeof window.addEventListener === "function" ? window : globalThis;
			bridgeTeardown?.();
			bridgeTeardown = installDomBridge(host, () => (typeof snapshotProbe === "function" ? snapshotProbe() : null));
		}
		//#endregion
		//#region lib/types/client/contextmenu.js
		/**
		 * The row context menu: 收藏 / 置顶 for one model, opened by a right-click on
		 * its row in the shipped model menu and rendered into `document.body` at the
		 * pointer, exactly like the shipped ModelSelect portals its own menu.
		 *
		 * @param props - the slot inject face (unused; the request holds everything).
		 * @returns the portaled menu, or null while closed.
		 */
		function ContextMenuHost() {
			const request = typeof useSyncExternalStore === "function" ? useSyncExternalStore(subscribeContext, currentContext) : useContextMenuFallback();
			if (typeof reactEffect === "function") reactEffect(() => {
				if (request === null) return void 0;
				const onScroll = () => closeContext();
				document.addEventListener("scroll", onScroll, true);
				return () => document.removeEventListener("scroll", onScroll, true);
			}, [request]);
			if (request === null || typeof createPortal !== "function" || MenuSurface === void 0) return null;
			const rows = [{
				id: "favorite",
				label: request.favorited ? translate("action.unfavorite") : translate("action.favorite"),
				icon: createElement(StarIcon, { filled: request.favorited }),
				onClick: () => {
					toggleFavorite(request.key);
					closeContext();
				}
			}, {
				id: "pin",
				label: request.pinned ? translate("action.unpin") : translate("action.pin"),
				icon: IconPinFillRegular === void 0 ? void 0 : createElement(IconPinFillRegular),
				onClick: () => {
					togglePin(request.key);
					closeContext();
				}
			}];
			return createPortal(createElement(MenuSurface, {
				className: MENU_CLASS,
				style: {
					position: "fixed",
					left: `${request.x}px`,
					top: `${request.y}px`,
					zIndex: 1400
				},
				role: "menu",
				"aria-label": request.name,
				// The shipped ModelSelect closes on any document `mousedown` outside its
				// own root/menu nodes, and on the focus loss that a click would cause.
				// Swallowing the down event here keeps the model list open while the
				// favorite/pin is applied, which is the whole point of the menu.
				onMouseDown: (event) => {
					event.preventDefault();
					event.stopPropagation();
				},
				onPointerDown: (event) => {
					event.stopPropagation();
				}
			}, rows.map((row) => createElement(FallbackMenuButton, {
				key: row.id,
				icon: row.icon,
				onClick: row.onClick
			}, row.label))), document.body);
		}
		/**
		 * React-17 fallback for the context subscription (the kernel hook set decides
		 * which runs; the branch is module constant, so hook order stays stable).
		 * @returns the current request.
		 */
		function useContextMenuFallback() {
			const [request, setRequest] = reactState(contextRequest);
			reactEffect(() => subscribeContext(() => setRequest(contextRequest)), []);
			return request;
		}
		/**
		 * The yellow five-pointed star. The primitives ship no star glyph, so the
		 * icon is a local SVG path that inherits the menu's text color unless the
		 * favorites gold is asked for (the row mark always is).
		 *
		 * @param props - `filled` paints a solid star, otherwise the outline.
		 * @returns the star, or the text glyph when no DOM is available.
		 */
		function StarIcon(props) {
			if (typeof document === "undefined") return "★";
			return createElement("svg", {
				width: 14,
				height: 14,
				viewBox: "0 0 24 24",
				fill: props?.filled === false ? "none" : "currentColor",
				stroke: "currentColor",
				"aria-hidden": "true",
				style: { color: "#f5b301" }
			}, createElement("path", {
				d: "M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9z"
			}));
		}
		/**
		 * One row of the context menu. Deliberately a plain button: the shipped
		 * `MenuItemButton` expects the `Menu` keyboard context, which a
		 * pointer-anchored menu does not provide.
		 *
		 * @param props - `{ icon, onClick, children }`.
		 * @returns the row element.
		 */
		function FallbackMenuButton(props) {
			return createElement("button", {
				type: "button",
				role: "menuitem",
				onClick: props?.onClick
			}, props?.icon === void 0 || props.icon === null ? null : createElement("span", { className: "dsh-model-favorites-menu-icon" }, props.icon), createElement("span", null, props?.children));
		}
		//#endregion
		//#region lib/types/client/index.js
		/**
		 * Activation gate: wait for the model directory service only. The command
		 * runtime, sessions, and locale are waited for inside apply's own inject
		 * phases, so a kernel without them still gets the data decoration.
		 */
		const inject = [
			"modelDirectories"
		];
		/**
		 * Build one management row per catalog model, plus the clear-all row. Row
		 * ids stay `<provider>/<model>` — the same identity the two lists and the
		 * /model picker use — so a selection needs no parsing. The synthetic 收藏
		 * group is skipped: its rows are the same models, and its composite ids
		 * would only duplicate them.
		 *
		 * @param snapshot - the (already decorated) directory snapshot.
		 * @param t - the plugin dictionary.
		 * @param mode - `favorite` marks/clears favorites, `pin` marks/clears pins.
		 * @returns the popup rows.
		 */
		function rowsOf(snapshot, t, mode) {
			const rows = [];
			const favorites = new Set(favoriteKeys());
			const pins = new Set(pinnedKeys());
			for (const group of snapshot.groups) {
				if (group.id === FAVORITES_GROUP_ID) continue;
				const label = providerLabelOf(group, t);
				for (const model of group.models) {
					const key = `${group.id}/${model.id}`;
					const marks = [];
					if (favorites.has(key)) marks.push("★");
					if (pins.has(key)) marks.push(t("option.pinned"));
					if (snapshot.current !== null && snapshot.current.provider === group.id && snapshot.current.model === model.id) marks.push(t("option.current"));
					rows.push({
						id: key,
						label: model.name,
						detail: marks.length === 0 ? void 0 : marks.join(" · "),
						group: {
							name: group.id,
							label
						}
					});
				}
			}
			const clearId = mode === "pin" ? CLEAR_PIN_ID : CLEAR_ID;
			const list = mode === "pin" ? pins : favorites;
			if (list.size > 0) rows.push({
				id: clearId,
				label: t(mode === "pin" ? "option.clear.pins" : "option.clear")
			});
			return rows;
		}
		/**
		 * Client plugin body: register the dictionaries, decorate the model
		 * directory service as soon as it exists (independent of the UI runtime),
		 * then contribute the two management commands and the row context menu.
		 *
		 * Every integration point is feature-detected so older kernels degrade to
		 * whatever they can support instead of failing the plugin load: no locale
		 * service keeps the built-in zh dictionary, no command runtime keeps the
		 * data decoration, no DOM keeps the two lists without the row menu.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			if (typeof ctx.inject !== "function") {
				console.warn("[model-favorites] kernel lacks ctx.inject — plugin disabled");
				return;
			}
			let t = (key) => zh[key] ?? key;
			try {
				const registerDictionaries = () => (typeof ctx.locale?.register === "function" ? ctx.locale.register(NS, { zh, en }) : void 0);
				if (typeof ctx.effect === "function") ctx.effect(registerDictionaries, "ui-model-favorites: dictionaries");
				else registerDictionaries();
				if (typeof ctx.locale?.bind === "function") t = ctx.locale.bind(NS);
				translate = t;
				// Publish this instance as the live owner of the two lists, so store
				// facades created by earlier activations read current data instead of
				// their own frozen copies.
				globalThis[SHARED] = Object.assign(sharedSlot(), {
					favoriteKeys,
					pinnedKeys,
					translate: (key) => translate(key)
				});
			} catch (error) {
				console.warn("[model-favorites] locale registration failed; using the built-in dictionary:", error);
			}
			console.info("[model-favorites] client half applying");
			// Data layer first: only the directory service is required, so a slow or
			// missing command runtime can never leave the decoration unwrapped.
			ctx.inject(["modelDirectories"], (scope) => {
				const models = scope.modelDirectories;
				if (models === void 0 || models === null) {
					console.warn("[model-favorites] modelDirectories service unavailable — decoration skipped");
					return;
				}
				patchResolver(models);
			});
			ctx.inject([
				"modelDirectories",
				"commandUi",
				"sessions",
				"slots"
			], (scope) => {
				const models = scope.modelDirectories;
				const command = typeof scope.get === "function" ? scope.get("commandUi") : scope.commandUi;
				const sessions = scope.sessions;
				if (models === void 0 || models === null || command === void 0 || typeof command.register !== "function") {
					console.warn("[model-favorites] commandUi or modelDirectories unavailable — commands and row menu skipped");
					return;
				}
				const effect = (fn, label) => (typeof scope.effect === "function" ? scope.effect(fn, label) : fn());
				/**
				 * One popupSelect management surface. Both commands share the row
				 * builder; they only differ in which list a selection toggles.
				 * @param mode - `favorite` or `pin`.
				 * @returns the popupSelect spec.
				 */
				const managementUi = (mode) => ({
					kind: "popupSelect",
					searchMode: "fuzzy-label",
					searchLabels: () => ({
						placeholder: t("search.placeholder"),
						empty: t("empty.models"),
						noResults: t("search.empty")
					}),
					options: async (session) => {
						if (sessions?.subagentAddress?.(session.sessionId) !== void 0) throw new Error(t("error.unavailable"));
						return rowsOf(await models.directoryFor(session.sessionId).load(), t, mode);
					},
					onSelect: async (option) => {
						if (option.id === CLEAR_ID) {
							clearFavorites();
							return;
						}
						if (option.id === CLEAR_PIN_ID) {
							clearPins();
							return;
						}
						if (mode === "pin") togglePin(option.id);
						else toggleFavorite(option.id);
					}
				});
				const ui = managementUi("favorite");
				const register = (spec, label) => {
					try {
						effect(() => command.register(spec), label);
						return true;
					} catch (error) {
						console.warn(`[model-favorites] ${label} failed:`, error);
						return false;
					}
				};
				const commandIcon = IconPinFillRegular === void 0 ? {} : { icon: IconPinFillRegular };
				const available = (session) => sessions?.subagentAddress?.(session.sessionId) === void 0;
				if (register({
					name: COMMAND_NAME,
					label: () => t("command.label"),
					description: () => t("command.description"),
					...commandIcon,
					available,
					ui
				}, "ui-model-favorites: /model-favorites contribution")) console.info("[model-favorites] /model-favorites command registered");
				else return;
				// The pin surface: the same rows, toggling the per-provider 置顶 list.
				register({
					name: PIN_COMMAND_NAME,
					label: () => t("pin.command.label"),
					description: () => t("pin.command.description"),
					...commandIcon,
					available,
					ui: managementUi("pin")
				}, "ui-model-favorites: /model-pins contribution");
				// The row context menu lives in the root overlay: `shell.overlay` is a
				// root-scoped list seat, so the menu escapes the composer's stacking
				// context and can be portaled to document.body at the pointer.
				if (typeof scope.slots?.inject === "function" && typeof scope.slots?.register === "function") try {
					scope.slots.inject("shell.overlay", () => scope.slots.register({
						name: "shell.overlay",
						id: "model-favorites-context-menu",
						locale: NS,
						inject: () => ({})
					}, ContextMenuHost));
					console.info("[model-favorites] row context menu registered");
				} catch (error) {
					console.warn("[model-favorites] row context menu registration failed:", error);
				}
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
