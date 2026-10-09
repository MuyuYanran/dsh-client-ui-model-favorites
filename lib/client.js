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
 *
 * Only the data path is wrapped: model ids, provider ids, selection and
 * reasoning-effort semantics are untouched, so the shipped pickers keep working
 * even if this plugin is disabled mid-session.
 */

window.__ModuleLoader__.load({
	id: "dsh-client-ui-model-favorites",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");
		const { IconPinFillRegular } = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region lib/types/client/locales.js
		/** Dictionary namespace owned by this plugin. */
		const NS = "modelFavorites";
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
			"error.unavailable": "子代理会话不支持收藏模型。"
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
			"error.unavailable": "Model favorites are unavailable for addressed subagent sessions."
		};
		//#endregion
		//#region lib/types/client/favorites.js
		/** localStorage key backing the ordered favorites list. */
		const STORAGE_KEY = "dsh-client-ui-model-favorites";
		/** Row id of the management command's clear-all action (never a provider/model key). */
		const CLEAR_ID = "\u0000model-favorites:clear";
		/**
		 * Ordered favorite keys (`<provider>/<model>`), newest pin last. The
		 * snapshot store's built-in persistence hydrates and writes localStorage,
		 * so favorites survive a restart without any host round trip.
		 */
		const favorites = createSnapshotStore({ ordered: [] }, { persist: { name: STORAGE_KEY } });
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
			} catch (error) {
				console.error("[model-favorites] failed to wrap modelDirectories.directoryFor:", error);
			}
		}
		//#endregion
		//#region lib/types/client/index.js
		/** Required services: the model directory service, the command registry, sessions, and locale. */
		const inject = [
			"modelDirectories",
			"commandUi",
			"sessions",
			"locale"
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
		 * directory service, and contribute the management command.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-model-favorites: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.inject([
				"modelDirectories",
				"commandUi",
				"sessions"
			], (scope) => {
				const models = scope.modelDirectories;
				const command = scope.get("commandUi");
				const sessions = scope.sessions;
				patchResolver(models);
				scope.effect(() => command.register({
					name: "model-favorites",
					label: () => t("command.label"),
					description: () => t("command.description"),
					icon: IconPinFillRegular,
					available: (session) => sessions.subagentAddress(session.sessionId) === void 0,
					ui: {
						kind: "popupSelect",
						searchMode: "fuzzy-label",
						searchLabels: () => ({
							placeholder: t("search.placeholder"),
							empty: t("empty.models"),
							noResults: t("search.empty")
						}),
						options: async (session) => {
							if (sessions.subagentAddress(session.sessionId) !== void 0) throw new Error(t("error.unavailable"));
							return rowsOf(await models.directoryFor(session.sessionId).load(), t);
						},
						onSelect: async (option) => {
							if (option.id === CLEAR_ID) {
								clearFavorites();
								return;
							}
							toggleFavorite(option.id);
						}
					}
				}), "ui-model-favorites: /model-favorites contribution");
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
