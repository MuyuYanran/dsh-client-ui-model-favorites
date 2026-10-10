/**
 * Model favorites plugin — browser half.
 *
 * Adds a favorite/pin layer to the shipped model pickers without replacing any
 * shipped component:
 *
 * 1. An ordered favorites list persisted in localStorage.
 * 2. A decorator over every session `ModelDirectory.store` snapshot: favorited
 *    models move to the top of their provider group, groups holding favorites
 *    float ahead of the remaining groups, and a favorited model's display name
 *    gains a trailing `★`. Both consumers of that snapshot — the composer's
 *    `conversation.input.model` seat (ModelSelect) and the `/model` popup
 *    (optionsOf) — therefore show pinned models first, with no UI fork.
 * 3. A `/model-favorites` command (popupSelect) that lists the catalog with the
 *    same ★ markers and toggles one model's pin per selection, plus a "clear
 *    all" row.
 * 4. A composer toolbar trigger (slot `conversation.input.left` — an additive
 *    list seat): a pin button that opens the same popup, so the feature is
 *    discoverable without knowing the command. It carries a live count badge.
 *
 * Only the data path is wrapped: model ids, provider ids, selection and
 * reasoning-effort semantics are untouched, so the shipped pickers keep working
 * even if this plugin is disabled mid-session.
 *
 * Kernel compatibility: every optional surface (primitives, React hooks, the
 * popup invocation path, the locale service, the slot seat) is feature-detected
 * and degrades independently; the favorites store falls back to a built-in
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
		const Button = primitives.Button;
		const IconPinFillRegular = primitives.IconPinFillRegular;
		const react = optional("react") ?? {};
		const createElement = react.createElement;
		const useSyncExternalStore = react.useSyncExternalStore;
		const reactState = react.useState;
		const reactEffect = react.useEffect;
		//#region lib/types/client/locales.js
		/** Dictionary namespace owned by this plugin. */
		const NS = "modelFavorites";
		/** The management command's name; the composer trigger opens the same popup. */
		const COMMAND_NAME = "model-favorites";
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
			"trigger.tooltip": "收藏模型（置顶显示）"
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
			"trigger.tooltip": "Model favorites (pinned to top)"
		};
		//#endregion
		//#region lib/types/client/favorites.js
		/** localStorage key backing the ordered favorites list. */
		const STORAGE_KEY = "dsh-client-ui-model-favorites";
		/** Row id of the management command's clear-all action (never a provider/model key). */
		const CLEAR_ID = "\u0000model-favorites:clear";
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
					const store = createSnapshotStore({ ordered: [] }, { persist: { name: STORAGE_KEY } });
					if (store !== null && typeof store === "object" && typeof store.getSnapshot === "function" && typeof store.subscribe === "function" && typeof store.update === "function" && typeof store.set === "function") return store;
					console.warn("[model-favorites] snapshot store contract incomplete; using the built-in fallback");
				} catch (error) {
					console.warn("[model-favorites] snapshot store unavailable; using the built-in fallback:", error);
				}
			}
			let state = { ordered: [] };
			if (typeof localStorage !== "undefined") {
				try {
					const raw = localStorage.getItem(STORAGE_KEY);
					if (typeof raw === "string") {
						const parsed = JSON.parse(raw);
						if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed.ordered)) state = { ordered: parsed.ordered.filter((key) => typeof key === "string") };
					}
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
		 * Ordered favorite keys (`<provider>/<model>`), newest pin last. The
		 * snapshot store's built-in persistence hydrates and writes localStorage,
		 * so favorites survive a restart without any host round trip.
		 */
		const favorites = createFavoritesStore();
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
		/** Live favorites list. */
		function favoriteKeys() {
			const ordered = favorites.getSnapshot().ordered;
			return Array.isArray(ordered) ? ordered : [];
		}
		/**
		 * Adopt another window's list (same-origin tabs share the localStorage key
		 * but not the in-memory store).
		 */
		if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
			window.addEventListener("storage", (event) => {
				if (event.key !== STORAGE_KEY || typeof event.newValue !== "string") return;
				try {
					const parsed = JSON.parse(event.newValue);
					if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.ordered)) return;
					if (parsed.ordered.some((key) => typeof key !== "string")) return;
					favorites.set({ ordered: parsed.ordered });
				} catch (error) {
					console.error("[model-favorites] failed to adopt another window's favorites:", error);
				}
			});
		}
		/**
		 * Toggle one `<provider>/<model>` key.
		 * @param key - the row id, which is exactly the provider/model identity.
		 */
		function toggleFavorite(key) {
			const index = favoriteKeys().indexOf(key);
			favorites.update((draft) => {
				if (index === -1) draft.ordered.push(key);
				else draft.ordered.splice(index, 1);
			});
		}
		/** Drop every pin. */
		function clearFavorites() {
			if (favoriteKeys().length === 0) return;
			favorites.set({ ordered: [] });
		}
		/**
		 * Derive the favorites-aware snapshot from one real directory snapshot.
		 *
		 * Favorited models move to the front of their own provider group (group id
		 * and model id stay untouched, so row ids and selection still resolve),
		 * groups that hold a favorite float ahead of the rest, and a favorited
		 * model's display name gains a trailing `★`. Every other field is shared
		 * with the input snapshot, and an unchanged presentation returns the input
		 * identity so `useSyncExternalStore` consumers never re-render for nothing.
		 *
		 * @param snapshot - the real directory snapshot.
		 * @returns the decorated snapshot, or the input when nothing is pinned.
		 */
		function decorateSnapshot(snapshot) {
			const ordered = favoriteKeys();
			if (ordered.length === 0) return snapshot;
			if (snapshot === null || typeof snapshot !== "object" || !Array.isArray(snapshot.groups)) return snapshot;
			const rank = new Map();
			for (let index = 0; index < ordered.length; index += 1) rank.set(ordered[index], index);
			const pinnedGroups = [];
			const restGroups = [];
			let changed = false;
			for (const group of snapshot.groups) {
				const pinned = [];
				const rest = [];
				for (const model of group.models) {
					const at = rank.get(`${group.id}/${model.id}`);
					if (at === void 0) rest.push(model);
					else pinned.push({
						model,
						at
					});
				}
				if (pinned.length === 0) {
					restGroups.push(group);
					continue;
				}
				changed = true;
				pinned.sort((left, right) => left.at - right.at);
				pinnedGroups.push({
					...group,
					models: [...pinned.map(({ model }) => ({
						...model,
						name: `${model.name} ★`
					})), ...rest]
				});
			}
			if (!changed) return snapshot;
			return {
				...snapshot,
				groups: [...pinnedGroups, ...restGroups]
			};
		}
		//#endregion
		//#region lib/types/client/directory.js
		/** Marks a directory whose store already serves favorites-aware snapshots. */
		const WRAPPED = Symbol("dsh-client-ui-model-favorites/wrapped");
		/** Marks a resolver whose directoryFor already decorates its directories. */
		const PATCHED = Symbol("dsh-client-ui-model-favorites/patched");
		/**
		 * Replace one directory's store with a favorites-aware facade over the real
		 * store. The facade keeps the whole store contract (`getSnapshot`,
		 * `subscribe`, `update`, `set`), forwards writes to the real store, and
		 * notifies its own subscribers whenever either the real snapshot or the
		 * favorites list changes. `dispose` is wrapped so both subscriptions die
		 * with the session scope.
		 *
		 * @param directory - the live ModelDirectory instance.
		 * @returns the same instance, decorated in place.
		 */
		function decorateDirectory(directory) {
			if (directory === null || typeof directory !== "object" || directory[WRAPPED] === true) return directory;
			const real = directory.store;
			if (real === null || typeof real !== "object" || typeof real.getSnapshot !== "function" || typeof real.subscribe !== "function") return directory;
			directory[WRAPPED] = true;
			let cachedRaw = null;
			let cachedVersion = -1;
			let cached = null;
			const listeners = new Set();
			const getSnapshot = () => {
				const raw = real.getSnapshot();
				if (raw !== cachedRaw || favoritesVersion !== cachedVersion) {
					cachedRaw = raw;
					cachedVersion = favoritesVersion;
					cached = decorateSnapshot(raw);
				}
				return cached;
			};
			const notify = () => {
				for (const listener of [...listeners]) listener();
			};
			const unsubscribeReal = real.subscribe(notify);
			const unsubscribeFavorites = favorites.subscribe(notify);
			directory.store = {
				getSnapshot,
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				update(mutator) {
					return real.update(mutator);
				},
				set(next) {
					return real.set(next);
				}
			};
			const dispose = directory.dispose;
			if (typeof dispose === "function") directory.dispose = function () {
				unsubscribeReal();
				unsubscribeFavorites();
				listeners.clear();
				return dispose.call(this);
			};
			return directory;
		}
		/**
		 * Decorate every directory the resolver already minted, then route future
		 * `directoryFor` calls through {@link decorateDirectory}.
		 *
		 * `directoryFor` is looked up on the service instance by both shipped
		 * consumers (the composer seat's slot inject and the /model command), so an
		 * own-property wrapper covers both without touching their registrations.
		 *
		 * @param resolver - the `modelDirectories` service instance.
		 */
		function patchResolver(resolver) {
			if (resolver === null || (typeof resolver !== "object" && typeof resolver !== "function")) return;
			if (resolver[PATCHED] === true) return;
			const original = resolver.directoryFor;
			if (typeof original !== "function") return;
			const values = resolver.live?.directories?.values;
			if (values !== void 0 && typeof values[Symbol.iterator] === "function") for (const directory of values) decorateDirectory(directory);
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
				resolver[PATCHED] = true;
				console.info("[model-favorites] modelDirectories.directoryFor wrapped");
			} catch (error) {
				console.error("[model-favorites] failed to wrap modelDirectories.directoryFor:", error);
			}
		}
		//#endregion
		//#region lib/types/client/trigger.js
		/**
		 * Open the management popup through the shipped commandUi runtime, the same
		 * path a bare `/model-favorites` Enter takes. The synthetic enter segment
		 * is consumed after a successful selection; consuming a token the draft
		 * never carried is a documented-benign no-op.
		 *
		 * @param command - the `commandUi` service.
		 * @param ui - the registered popupSelect spec.
		 * @param sessionId - the session whose popup should open.
		 */
		function openFavorites(command, ui, sessionId) {
			try {
				command.invoke(COMMAND_NAME, ui, { sessionId }, { via: "enter", token: `/${COMMAND_NAME}` });
			} catch (error) {
				console.warn("[model-favorites] failed to open the favorites popup:", error);
			}
		}
		/**
		 * Favorites count for the trigger badge. Prefers React 18's
		 * `useSyncExternalStore`; on React 17 kernels a subscribe-into-state hook
		 * keeps the badge live. The branch condition is a module constant, so hook
		 * order stays stable across renders.
		 * @returns the current favorites count.
		 */
		function useFavoritesCount() {
			if (typeof useSyncExternalStore === "function") return useSyncExternalStore(favorites.subscribe, () => favoriteKeys().length);
			const [count, setCount] = reactState(favoriteKeys().length);
			reactEffect(() => favorites.subscribe(() => setCount(favoriteKeys().length)), []);
			return count;
		}
		/**
		 * The composer toolbar trigger. Renders nothing outside a regular session;
		 * the count rides {@link useFavoritesCount} so a pin made in another window
		 * (storage event) updates the badge too.
		 *
		 * @param props - the slot inject face (`sessionId`, `available`).
		 * @param deps - closed-over command runtime, popup spec, and dictionary.
		 * @returns the pin button, or null when unavailable.
		 */
		function FavoritesTrigger({ sessionId, available }, deps) {
			const { command, ui, t } = deps;
			const count = useFavoritesCount();
			if (available !== true || typeof sessionId !== "string") return null;
			return createElement(Button, {
				variant: "ghost",
				size: "sm",
				icon: createElement(IconPinFillRegular),
				"aria-label": t("command.label"),
				title: t("trigger.tooltip"),
				onClick: () => openFavorites(command, ui, sessionId)
			}, count > 0 ? String(count) : void 0);
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
		 * ids stay `<provider>/<model>` — the same identity the pinned list and the
		 * /model picker use — so a selection needs no parsing.
		 * @param snapshot - the (already decorated) directory snapshot.
		 * @param t - the plugin dictionary.
		 * @returns the popup rows.
		 */
		function rowsOf(snapshot, t) {
			const rows = [];
			for (const group of snapshot.groups) {
				const label = group.id === "deepseek-account" ? t("provider.account") : group.name;
				for (const model of group.models) rows.push({
					id: `${group.id}/${model.id}`,
					label: model.name,
					detail: snapshot.current !== null && snapshot.current.provider === group.id && snapshot.current.model === model.id ? t("option.current") : void 0,
					group: {
						name: group.id,
						label
					}
				});
			}
			if (favoriteKeys().length > 0) rows.push({
				id: CLEAR_ID,
				label: t("option.clear")
			});
			return rows;
		}
		/**
		 * Client plugin body: register the dictionaries, decorate the model
		 * directory service as soon as it exists (independent of the UI runtime),
		 * then contribute the management command and the composer toolbar trigger.
		 *
		 * Every integration point is feature-detected so older kernels degrade to
		 * whatever they can support instead of failing the plugin load: no locale
		 * service keeps the built-in zh dictionary, no command runtime keeps the
		 * data decoration, no popup invocation path keeps just the command.
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
				"sessions"
			], (scope) => {
				const models = scope.modelDirectories;
				const command = typeof scope.get === "function" ? scope.get("commandUi") : scope.commandUi;
				const sessions = scope.sessions;
				if (models === void 0 || models === null || command === void 0 || typeof command.register !== "function") {
					console.warn("[model-favorites] commandUi or modelDirectories unavailable — command and trigger skipped");
					return;
				}
				const effect = (fn, label) => (typeof scope.effect === "function" ? scope.effect(fn, label) : fn());
				const ui = {
					kind: "popupSelect",
					searchMode: "fuzzy-label",
					searchLabels: () => ({
						placeholder: t("search.placeholder"),
						empty: t("empty.models"),
						noResults: t("search.empty")
					}),
					options: async (session) => {
						if (sessions?.subagentAddress?.(session.sessionId) !== void 0) throw new Error(t("error.unavailable"));
						return rowsOf(await models.directoryFor(session.sessionId).load(), t);
					},
					onSelect: async (option) => {
						if (option.id === CLEAR_ID) {
							clearFavorites();
							return;
						}
						toggleFavorite(option.id);
					}
				};
				try {
					effect(() => command.register({
						name: COMMAND_NAME,
						label: () => t("command.label"),
						description: () => t("command.description"),
						...(IconPinFillRegular !== void 0 ? { icon: IconPinFillRegular } : {}),
						available: (session) => sessions?.subagentAddress?.(session.sessionId) === void 0,
						ui
					}), "ui-model-favorites: /model-favorites contribution");
					console.info("[model-favorites] /model-favorites command registered");
				} catch (error) {
					console.warn("[model-favorites] command registration failed:", error);
					return;
				}
				// Discoverable affordance: a pin button in the composer tool row that
				// opens the very same popup. Needs the shipped popup invocation path,
				// the icon set, and a React with workable hooks.
				const triggerReady = typeof command.invoke === "function" && Button !== void 0 && IconPinFillRegular !== void 0 && typeof createElement === "function" && (typeof useSyncExternalStore === "function" || typeof reactState === "function" && typeof reactEffect === "function");
				if (triggerReady !== true || typeof scope.slots?.inject !== "function" || typeof scope.slots?.register !== "function") {
					console.info("[model-favorites] composer trigger skipped (kernel lacks the popup invocation path or icon primitives)");
					return;
				}
				try {
					scope.slots.inject("conversation.input.left", () => scope.slots.register({
						name: "conversation.input.left",
						id: "model-favorites-trigger",
						order: 50,
						locale: NS,
						inject: (sessionId) => ({
							sessionId,
							available: typeof sessionId === "string" && sessions?.subagentAddress?.(sessionId) === void 0
						})
					}, (props) => FavoritesTrigger(props, { command, ui, t })));
					console.info("[model-favorites] composer trigger registered");
				} catch (error) {
					console.warn("[model-favorites] composer trigger registration failed:", error);
				}
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
