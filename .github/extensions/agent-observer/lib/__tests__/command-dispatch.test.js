/**
 * Tests for the command dispatcher fallback mechanism.
 *
 * The dispatcher fallback patches session._executeCommandAndRespond to ensure
 * our command handlers are in the commandHandlers map just before lookup,
 * regardless of whether something else cleared the map after joinSession.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

describe("command dispatcher fallback", () => {
    let session;
    let dispatchCalls;
    let openCalled;

    const openObserverHandler = async () => { openCalled = true; };

    const COMMANDS = [
        { name: "agent-observer", description: "Open the agent observer webview window.", handler: openObserverHandler },
        { name: "observer",       description: "Open the agent observer webview window.", handler: openObserverHandler },
    ];

    const OBSERVER_COMMAND_NAMES = new Set(COMMANDS.map(c => c.name));

    /** Simulate the SDK's _executeCommandAndRespond behavior */
    function createMockSession() {
        const rpcResults = [];
        const sess = {
            commandHandlers: new Map(),
            rpc: {
                commands: {
                    handlePendingCommand: async (payload) => { rpcResults.push(payload); },
                },
            },
            _rpcResults: rpcResults,
        };

        // Simulate SDK's _executeCommandAndRespond
        sess._executeCommandAndRespond = async function (requestId, commandName, command, args) {
            const handler = this.commandHandlers.get(commandName);
            if (!handler) {
                await this.rpc.commands.handlePendingCommand({
                    requestId,
                    error: `Unknown command: ${commandName}`,
                });
                return;
            }
            try {
                await handler({ sessionId: "test-session", command, commandName, args });
                await this.rpc.commands.handlePendingCommand({ requestId });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                await this.rpc.commands.handlePendingCommand({ requestId, error: message });
            }
        };

        return sess;
    }

    /** Apply the same dispatcher fallback logic from main.mjs */
    function applyDispatcherFallback(sess) {
        const originalDispatch = sess._executeCommandAndRespond.bind(sess);
        sess._executeCommandAndRespond = async function (requestId, commandName, command, args) {
            if (OBSERVER_COMMAND_NAMES.has(commandName) && sess.commandHandlers instanceof Map) {
                sess.commandHandlers.set(commandName, openObserverHandler);
            }
            return originalDispatch(requestId, commandName, command, args);
        };
    }

    beforeEach(() => {
        session = createMockSession();
        openCalled = false;
        dispatchCalls = [];
    });

    it("handles /observer when commandHandlers map is empty", async () => {
        applyDispatcherFallback(session);
        // Map is empty — simulates the bug condition
        assert.equal(session.commandHandlers.size, 0);

        await session._executeCommandAndRespond("req-1", "observer", {}, []);

        assert.equal(openCalled, true);
        assert.equal(session._rpcResults.length, 1);
        assert.deepEqual(session._rpcResults[0], { requestId: "req-1" }); // success, no error
    });

    it("handles /agent-observer when commandHandlers map is empty", async () => {
        applyDispatcherFallback(session);

        await session._executeCommandAndRespond("req-2", "agent-observer", {}, []);

        assert.equal(openCalled, true);
        assert.deepEqual(session._rpcResults[0], { requestId: "req-2" });
    });

    it("delegates non-observer commands to original dispatch", async () => {
        const customHandler = async () => { dispatchCalls.push("custom"); };
        session.commandHandlers.set("other-command", customHandler);
        applyDispatcherFallback(session);

        await session._executeCommandAndRespond("req-3", "other-command", {}, []);

        assert.equal(dispatchCalls.length, 1);
        assert.equal(openCalled, false);
        assert.deepEqual(session._rpcResults[0], { requestId: "req-3" });
    });

    it("reports Unknown command for unregistered non-observer commands", async () => {
        applyDispatcherFallback(session);

        await session._executeCommandAndRespond("req-4", "unknown-cmd", {}, []);

        assert.equal(openCalled, false);
        assert.deepEqual(session._rpcResults[0], {
            requestId: "req-4",
            error: "Unknown command: unknown-cmd",
        });
    });

    it("still works even if commandHandlers map was cleared after patch", async () => {
        // Register normally first
        session.commandHandlers.set("observer", openObserverHandler);
        applyDispatcherFallback(session);

        // Simulate a later registerCommands(undefined) clearing the map
        session.commandHandlers.clear();
        assert.equal(session.commandHandlers.size, 0);

        // Dispatch should still work thanks to the fallback
        await session._executeCommandAndRespond("req-5", "observer", {}, []);

        assert.equal(openCalled, true);
        assert.deepEqual(session._rpcResults[0], { requestId: "req-5" });
    });

    it("does not interfere when handlers are already registered", async () => {
        // Handlers already in map (normal case)
        session.commandHandlers.set("observer", openObserverHandler);
        session.commandHandlers.set("agent-observer", openObserverHandler);
        applyDispatcherFallback(session);

        await session._executeCommandAndRespond("req-6", "observer", {}, []);

        assert.equal(openCalled, true);
        assert.deepEqual(session._rpcResults[0], { requestId: "req-6" });
    });

    it("is a no-op when _executeCommandAndRespond is missing", () => {
        // Simulate an older SDK without the dispatch method
        delete session._executeCommandAndRespond;

        // Should not throw
        assert.doesNotThrow(() => {
            // Inline the same guard logic from main.mjs
            if (typeof session._executeCommandAndRespond === "function") {
                const originalDispatch = session._executeCommandAndRespond.bind(session);
                session._executeCommandAndRespond = async function (requestId, commandName) {
                    if (OBSERVER_COMMAND_NAMES.has(commandName) && session.commandHandlers instanceof Map) {
                        session.commandHandlers.set(commandName, openObserverHandler);
                    }
                    return originalDispatch(requestId, commandName);
                };
            }
        });

        // Method should remain absent
        assert.equal(session._executeCommandAndRespond, undefined);
    });
});
