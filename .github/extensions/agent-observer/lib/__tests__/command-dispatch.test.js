/**
 * Tests for the command dispatcher fallback mechanism.
 *
 * PRIMARY: Patches Map.prototype.get on commandHandlers so that .get(name)
 * always returns our handler for observer/agent-observer, even after clear().
 * Handles both raw names ("observer") and slash-prefixed ("/observer").
 *
 * SECONDARY: Also patches _executeCommandAndRespond as belt-and-suspenders.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

/** Normalize a command name — strip leading "/" if present, trim whitespace. */
function normalizeCmd(name) {
    if (typeof name !== "string") return name;
    const trimmed = name.trim();
    return trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
}

describe("command dispatcher fallback — Map.get() patch", () => {
    let openCalled;
    const openObserverHandler = async () => { openCalled = true; };

    const COMMANDS = [
        { name: "agent-observer", description: "Open", handler: openObserverHandler },
        { name: "observer",       description: "Open", handler: openObserverHandler },
    ];
    const OBSERVER_COMMAND_NAMES = new Set(COMMANDS.map(c => c.name));
    const OBSERVER_HANDLERS = new Map(COMMANDS.map(c => [c.name, c.handler]));

    /** Apply the Map.get() patch — mirrors main.mjs logic */
    function applyMapGetPatch(cmdMap) {
        const nativeGet = Map.prototype.get;
        cmdMap.get = function (key) {
            const activeMap = this instanceof Map ? this : cmdMap;
            const norm = normalizeCmd(key);
            if (OBSERVER_COMMAND_NAMES.has(key) || OBSERVER_COMMAND_NAMES.has(norm)) {
                return OBSERVER_HANDLERS.get(norm);
            }
            return nativeGet.call(activeMap, key);
        };
    }

    /** Simulates SDK's _executeCommandAndRespond using map.get() */
    async function sdkDispatch(cmdMap, commandName) {
        const handler = cmdMap.get(commandName);
        if (!handler) return { error: `Unknown command: ${commandName}` };
        await handler();
        return { success: true };
    }

    beforeEach(() => { openCalled = false; });

    it("returns our handler for /observer even when map is empty", async () => {
        const map = new Map();
        applyMapGetPatch(map);
        assert.equal(map.size, 0);

        const result = await sdkDispatch(map, "observer");
        assert.equal(openCalled, true);
        assert.deepEqual(result, { success: true });
    });

    it("returns our handler for /agent-observer even when map is empty", async () => {
        const map = new Map();
        applyMapGetPatch(map);

        const result = await sdkDispatch(map, "agent-observer");
        assert.equal(openCalled, true);
        assert.deepEqual(result, { success: true });
    });

    it("handles slash-prefixed command names (/observer)", async () => {
        const map = new Map();
        applyMapGetPatch(map);

        const result = await sdkDispatch(map, "/observer");
        assert.equal(openCalled, true);
        assert.deepEqual(result, { success: true });
    });

    it("handles slash-prefixed command names (/agent-observer)", async () => {
        const map = new Map();
        applyMapGetPatch(map);

        const result = await sdkDispatch(map, "/agent-observer");
        assert.equal(openCalled, true);
        assert.deepEqual(result, { success: true });
    });

    it("still works after map.clear() (simulates registerCommands(undefined))", async () => {
        const map = new Map();
        map.set("observer", openObserverHandler);
        applyMapGetPatch(map);

        map.clear();
        assert.equal(map.size, 0);

        const result = await sdkDispatch(map, "observer");
        assert.equal(openCalled, true);
        assert.deepEqual(result, { success: true });
    });

    it("delegates non-observer commands to native Map.get()", async () => {
        const map = new Map();
        let otherCalled = false;
        map.set("other-cmd", async () => { otherCalled = true; });
        applyMapGetPatch(map);

        const handler = map.get("other-cmd");
        assert.ok(handler);
        await handler();
        assert.equal(otherCalled, true);
        assert.equal(openCalled, false);
    });

    it("returns undefined for truly unknown commands", async () => {
        const map = new Map();
        applyMapGetPatch(map);

        const result = await sdkDispatch(map, "nonexistent");
        assert.equal(openCalled, false);
        assert.deepEqual(result, { error: "Unknown command: nonexistent" });
    });

    it("survives multiple clear/repopulate cycles", async () => {
        const map = new Map();
        applyMapGetPatch(map);

        for (let i = 0; i < 5; i++) {
            map.clear();
            map.set("something-else", () => {});
        }

        const result = await sdkDispatch(map, "observer");
        assert.equal(openCalled, true);
        assert.deepEqual(result, { success: true });
    });

    it("works when .get() is called unbound (extracted reference)", async () => {
        const map = new Map();
        applyMapGetPatch(map);

        // Extract the get method and call without binding
        const getFn = map.get;
        const handler = getFn.call(map, "observer");
        assert.ok(handler);
    });
});

describe("normalizeCmd", () => {
    it("strips leading slash", () => {
        assert.equal(normalizeCmd("/observer"), "observer");
    });

    it("leaves bare names unchanged", () => {
        assert.equal(normalizeCmd("observer"), "observer");
    });

    it("trims whitespace", () => {
        assert.equal(normalizeCmd("  /observer  "), "observer");
    });

    it("handles non-string input gracefully", () => {
        assert.equal(normalizeCmd(undefined), undefined);
        assert.equal(normalizeCmd(null), null);
    });
});

describe("command dispatcher fallback — _executeCommandAndRespond patch", () => {
    let openCalled;
    const openObserverHandler = async () => { openCalled = true; };

    const COMMANDS = [
        { name: "agent-observer", description: "Open", handler: openObserverHandler },
        { name: "observer",       description: "Open", handler: openObserverHandler },
    ];
    const OBSERVER_COMMAND_NAMES = new Set(COMMANDS.map(c => c.name));
    const OBSERVER_HANDLERS = new Map(COMMANDS.map(c => [c.name, c.handler]));

    function createMockSession() {
        const rpcResults = [];
        const sess = {
            commandHandlers: new Map(),
            rpc: { commands: { handlePendingCommand: async (p) => { rpcResults.push(p); } } },
            _rpcResults: rpcResults,
        };
        sess._executeCommandAndRespond = async function (requestId, commandName) {
            const handler = this.commandHandlers.get(commandName);
            if (!handler) {
                await this.rpc.commands.handlePendingCommand({ requestId, error: `Unknown command: ${commandName}` });
                return;
            }
            await handler();
            await this.rpc.commands.handlePendingCommand({ requestId });
        };
        return sess;
    }

    function applyDispatcherPatch(sess) {
        const orig = sess._executeCommandAndRespond.bind(sess);
        sess._executeCommandAndRespond = async function (requestId, commandName, command, args) {
            const norm = normalizeCmd(commandName);
            if ((OBSERVER_COMMAND_NAMES.has(commandName) || OBSERVER_COMMAND_NAMES.has(norm))
                && this?.commandHandlers instanceof Map) {
                this.commandHandlers.set(commandName, OBSERVER_HANDLERS.get(norm));
            }
            return orig(requestId, commandName, command, args);
        };
    }

    beforeEach(() => { openCalled = false; });

    it("injects handler into empty map before dispatch", async () => {
        const session = createMockSession();
        applyDispatcherPatch(session);

        await session._executeCommandAndRespond("r1", "observer", {}, []);
        assert.equal(openCalled, true);
        assert.deepEqual(session._rpcResults[0], { requestId: "r1" });
    });

    it("handles slash-prefixed command name", async () => {
        const session = createMockSession();
        applyDispatcherPatch(session);

        await session._executeCommandAndRespond("r2", "/observer", {}, []);
        assert.equal(openCalled, true);
    });

    it("is a no-op when _executeCommandAndRespond is missing", () => {
        const session = createMockSession();
        delete session._executeCommandAndRespond;
        assert.doesNotThrow(() => {
            if (typeof session._executeCommandAndRespond === "function") {
                applyDispatcherPatch(session);
            }
        });
        assert.equal(session._executeCommandAndRespond, undefined);
    });
});
